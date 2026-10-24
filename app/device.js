/**
 * Device Module
 * Handles all Apple TV device operations: scanning, pairing, connecting, commands.
 * Wraps atvjs library and manages credential storage.
 */

const atvjs = require('@bharper/atv-js');
const dgram = require('dgram');
const os = require('os');
const dnsPacket = require('dns-packet');
const EventEmitter = require('events');
const { States, appState } = require('./state');

const events = new EventEmitter();

// Connection state
let connection = null;
let pairingSession = null;
let pairingDevice = null;

// Retry configuration
const CONNECT_RETRY_DELAY = 1000; // ms between retries

/**
 * Scan for Apple TV devices on the network
 * @param {number} timeout - Scan timeout in ms
 * @returns {Promise<string[]>} Array of device strings in format "Name (IP)"
 */
async function scan(timeout = 5000) {
    try {
        const devices = await scanAppleTVs(timeout);
        return devices.map(d => `${d.name} (${d.address})`);
    } catch (err) {
        console.error('Scan error:', err);
        return [];
    }
}

/**
 * atv-js only accepts "J..." model codes, which come from _device-info.
 * Some Apple TVs only report "AppleTV14,1" (rpMd), so filter here instead.
 */
function isAppleTV(model) {
    return /^(AppleTV|J)/.test(model || '');
}

/**
 * Multicast discovery plus a unicast sweep of the local subnet, for networks
 * (some routers and mesh Wi-Fi) that drop multicast between devices.
 */
async function scanAppleTVs(timeout = 5000) {
    const [multicast, unicast] = await Promise.all([
        atvjs.scan(timeout, false),
        queryCompanion(localSubnetHosts(), Math.min(timeout, 3000))
    ]);
    const byAddress = new Map(unicast.map(d => [d.address, d]));
    multicast.forEach(d => byAddress.set(d.address, d));
    return [...byAddress.values()].filter(d => isAppleTV(d.model));
}

const COMPANION_PTR = '_companion-link._tcp.local';

/**
 * Turn a unicast mDNS reply into a device in atv-js scan format
 */
function parseCompanion(packet, ip) {
    const records = [...packet.answers, ...packet.additionals];
    const instance = records.find(r => r.type === 'PTR' && r.name === COMPANION_PTR);
    const srv = instance && records.find(r => r.type === 'SRV' && r.name === instance.data);
    if (!srv) return null;

    const properties = {};
    records
        .filter(r => r.type === 'TXT' && r.name === instance.data)
        .flatMap(r => r.data)
        .forEach(entry => {
            const [key, ...rest] = entry.toString().split('=');
            properties[key] = rest.join('=');
        });
    const infoModel = records
        .filter(r => r.type === 'TXT' && r.name.endsWith('._device-info._tcp.local'))
        .flatMap(r => r.data)
        .map(entry => entry.toString())
        .find(entry => entry.startsWith('model='));

    const name = instance.data.replace('.' + COMPANION_PTR, '');
    return {
        name,
        address: ip,
        port: srv.data.port,
        airplayPort: 7000,
        identifier: properties.rpMRtID || properties.rpBA || name,
        model: infoModel ? infoModel.slice('model='.length) : (properties.rpMd || ''),
        properties
    };
}

/**
 * Ask hosts directly for their Companion service (unicast mDNS queries).
 * Works on networks that drop multicast discovery traffic.
 * @param {string[]} ips - IPv4 addresses to ask
 * @returns {Promise<Object[]>} Devices that answered, in atv-js scan format
 */
function queryCompanion(ips, timeout = 3000) {
    return new Promise(resolve => {
        const socket = dgram.createSocket('udp4');
        const found = new Map();
        const finish = () => {
            clearTimeout(timer);
            socket.close();
            resolve([...found.values()]);
        };
        const timer = setTimeout(finish, timeout);

        socket.on('error', finish);
        socket.on('message', (msg, rinfo) => {
            let device;
            try {
                device = parseCompanion(dnsPacket.decode(msg), rinfo.address);
            } catch (err) {
                return;
            }
            if (!device) return;
            found.set(rinfo.address, device);
            if (ips.length === 1) finish();
        });

        const query = dnsPacket.encode({ type: 'query', questions: [{ name: COMPANION_PTR, type: 'PTR' }] });
        // Unreachable hosts are expected during a sweep; ignore per-send errors
        ips.forEach(ip => socket.send(query, 5353, ip, () => {}));
    });
}

function lookupByIp(ip, timeout = 3000) {
    return queryCompanion([ip], timeout).then(devices => devices[0] || null);
}

/**
 * Every host in the /24 around each private IPv4 address of this machine.
 * ponytail: only the /24 is swept; Apple TVs elsewhere on a larger subnet still
 * need multicast discovery or manual IP entry.
 */
function localSubnetHosts() {
    const privateIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
    const hosts = new Set();
    Object.values(os.networkInterfaces()).flat()
        .filter(i => i.family === 'IPv4' && !i.internal && privateIp.test(i.address))
        .forEach(i => {
            const base = i.address.split('.').slice(0, 3).join('.');
            for (let h = 1; h < 255; h++) hosts.add(`${base}.${h}`);
        });
    return [...hosts];
}

/**
 * Start pairing with a device (Companion)
 * @param {string} deviceString - Device in format "Name (IP)"
 */
async function startPair(deviceString) {
    // Parse device string to get IP - match the LAST parenthesized value
    // Handles device names with parentheses like "Upstairs Bedroom (3) (192.168.1.223)"
    const match = deviceString.match(/\(([^)]+)\)$/);
    if (!match) {
        throw new Error('Invalid device string format');
    }
    const ip = match[1];

    // Ask the IP directly; fall back to a full scan if it doesn't answer
    const device = await lookupByIp(ip)
        || (await scanAppleTVs(5000)).find(d => d.address === ip);
    if (!device) {
        throw new Error(`No Apple TV answered at ${ip}`);
    }

    pairingDevice = device;

    // Start Companion pairing
    pairingSession = await atvjs.startCompanionPairing(device);
    pairingSession._phase = 1;
    pairingSession._device = device;

    return { phase: 1, protocol: 'Companion' };
}

/**
 * Backward-compatible alias for legacy two-phase flow.
 * @param {string} pin - 4-digit PIN from Apple TV screen
 */
async function finishPair1(pin) {
    return finishPair2(pin);
}

/**
 * Complete Companion pairing with PIN
 * @param {string} pin - 4-digit PIN from Apple TV screen
 * @returns {Promise<Object>} Complete credentials
 */
async function finishPair2(pin) {
    if (!pairingSession) {
        throw new Error('No Companion pairing session active');
    }

    // Complete Companion pairing
    const companionCreds = await atvjs.finishCompanionPairing(pairingSession, pin);

    // Build complete credentials object
    const credentials = {
        airplay: '',
        companion: atvjs.serializeCredentials(companionCreds),
        device: {
            name: pairingDevice.name,
            address: pairingDevice.address,
            port: pairingDevice.port,
            airplayPort: pairingDevice.airplayPort,
            identifier: pairingDevice.identifier
        }
    };

    // Clean up pairing state
    pairingSession = null;
    pairingDevice = null;

    return credentials;
}

function normalizeCredentials(credentials) {
    if (!credentials) {
        return null;
    }
    return {
        airplay: credentials.airplay || credentials.credentials || '',
        companion: credentials.companion || credentials.Companion || null
    };
}

function buildCredentialsFromSnapshot(snapshot) {
    return {
        airplay: snapshot.airplay || '',
        companion: snapshot.companion,
        device: {
            name: snapshot.device.name,
            address: snapshot.device.address,
            port: snapshot.device.port,
            airplayPort: snapshot.device.airplayPort,
            identifier: snapshot.device.identifier
        }
    };
}

function getCredIdentifier(creds) {
    if (!creds) {
        return null;
    }
    return (creds.device && creds.device.identifier) || creds.identifier || null;
}

function getCredCompanion(creds) {
    if (!creds) {
        return null;
    }
    return creds.companion || creds.Companion || null;
}

function credentialsMatch(left, right) {
    if (!left || !right) {
        return false;
    }

    const leftIdentifier = getCredIdentifier(left);
    const rightIdentifier = getCredIdentifier(right);
    if (leftIdentifier && rightIdentifier) {
        return leftIdentifier === rightIdentifier;
    }

    const leftCompanion = getCredCompanion(left);
    const rightCompanion = getCredCompanion(right);
    if (leftCompanion && rightCompanion) {
        return leftCompanion === rightCompanion;
    }

    return false;
}

function persistUpdatedCredentialsIfNeeded(providedCredentials, usedCredentials) {
    if (!usedCredentials) {
        return;
    }

    const updatedCredentials = buildCredentialsFromSnapshot(usedCredentials);
    setActiveCredentials(updatedCredentials);

    const all = getAllCredentials();
    let didUpdateStored = false;

    Object.keys(all).forEach((name) => {
        if (credentialsMatch(all[name], providedCredentials)) {
            all[name] = updatedCredentials;
            didUpdateStored = true;
        }
    });

    if (didUpdateStored) {
        localStorage.setItem(CREDS_KEY, JSON.stringify(all));
    }
}

function shouldMigrateProvidedCredentials(credentials) {
    if (!credentials) {
        return false;
    }

    // Legacy shape from older app versions
    if (credentials.credentials || credentials.Companion) {
        return true;
    }

    // Missing device metadata means we can now enrich persisted creds
    if (!credentials.device) {
        return true;
    }

    return false;
}

/**
 * Connect to an Apple TV using credentials, with retry logic
 * @param {Object} credentials - Credentials object
 * @param {boolean} isRetry - Whether this is a retry attempt
 */
async function connect(credentials, isRetry = false) {
    const normalized = normalizeCredentials(credentials);
    if (!normalized) {
        throw new Error('Invalid credentials format. Please re-pair your Apple TV.');
    }

    const creds = {
        airplay: normalized.airplay || '',
        companion: normalized.companion
    };
    let device = credentials.device;

    // If device info not stored in credentials, we need to scan
    if (!device) {
        const devices = await scanAppleTVs(5000);
        if (credentials.identifier) {
            device = devices.find(d => d.identifier === credentials.identifier);
        }
        if (!device && devices.length > 0) {
            device = devices[0];
        }
        if (!device) {
            throw new Error('Could not find Apple TV on network. Make sure it is powered on.');
        }
    }

    // Validate credentials format
    if (!creds.companion) {
        throw new Error('Invalid credentials format. Please re-pair your Apple TV.');
    }

    // Connect using atvjs
    connection = await atvjs.connect(device, creds);
    window.atvConnection = connection;

    if (!connection.usedCredentialsMatchProvided || shouldMigrateProvidedCredentials(credentials)) {
        persistUpdatedCredentialsIfNeeded(credentials, connection.usedCredentials);
    }

    // Set up connection lost handler
    atvjs.onConnectionLost(connection, (error) => {
        console.log('Connection lost:', error);
        connection = null;
        window.atvConnection = null;
        events.emit('connection_lost', error);
    });

    events.emit('connected');
    return true;
}

/**
 * Connect with automatic retry on failure
 * Uses appState to track retry count
 * @param {Object} credentials
 */
async function connectWithRetry(credentials) {
    try {
        await connect(credentials);
        appState.transition(States.CONNECTED);
    } catch (err) {
        console.error('Connection failed:', err.message);

        if (appState.shouldRetryConnection()) {
            console.log(`Retrying connection (attempt ${appState.connectRetries + 1})...`);
            // Stay in CONNECTING state (increments retry counter)
            appState.transition(States.CONNECTING, { credentials });

            await new Promise(resolve => setTimeout(resolve, CONNECT_RETRY_DELAY));
            return connectWithRetry(credentials);
        } else {
            console.log('Max retries reached, falling back to scan');
            appState.transition(States.SCANNING);
            throw err;
        }
    }
}

/**
 * Disconnect from the Apple TV
 */
function disconnect() {
    if (connection) {
        atvjs.disconnect(connection);
        connection = null;
    }
}

/**
 * Check if connected
 */
function isConnected() {
    return connection && atvjs.isConnected(connection);
}

/**
 * Send a remote control key
 * @param {string} key - Key name (up, down, left, right, select, menu, etc.)
 * @param {string} action - Optional action type ('Hold', 'DoubleTap')
 */
async function sendKey(key, action) {
    if (!connection) {
        throw new Error('Not connected');
    }

    // Handle long-press keys
    if (action === 'Hold') {
        if (key === 'home' || key === 'home_hold') {
            key = 'home_hold';
        }
    }

    await atvjs.sendKey(connection, key);
}

/**
 * Check if keyboard is focused on Apple TV
 */
async function getKeyboardFocus() {
    if (!connection) return false;
    try {
        return await atvjs.getKeyboardFocusState(connection);
    } catch (err) {
        console.error('getKeyboardFocus error:', err);
        return false;
    }
}

/**
 * Get current text from focused keyboard field
 */
async function getText(tries = 3) {
    if (!connection) return null;
    try {
        let text = await atvjs.getText(connection);
        text = text.trim();
        if ((text === null || text === '') && tries > 0) {
            tries--;
            await new Promise(resolve => setTimeout(resolve, 100));
            
            return await getText(tries);
        }
        console.log(`getText text: ${text}, tries: ${tries}`);
        return text;
    } catch (err) {
        console.error('getText error:', err);
        return null;
    }
}

/**
 * Set text in focused keyboard field
 */
async function setText(text) {
    if (!connection) return;
    try {
        await atvjs.setText(connection, text);
    } catch (err) {
        console.error('setText error:', err);
    }
}

// ============ Credential Storage ============

const CREDS_KEY = 'remote_credentials';
const ACTIVE_CREDS_KEY = 'atvcreds';

/**
 * Save credentials for a device
 * @param {string} name - Device name
 * @param {Object} creds - Credentials object
 */
function saveCredentials(name, creds) {
    let parsed = creds;
    if (typeof creds === 'string') {
        parsed = JSON.parse(creds);
    }

    const all = getAllCredentials();
    all[name] = parsed;
    localStorage.setItem(CREDS_KEY, JSON.stringify(all));
}

/**
 * Get all saved credentials
 * @returns {Object} Map of device name to credentials
 */
function getAllCredentials() {
    try {
        return JSON.parse(localStorage.getItem(CREDS_KEY) || '{}');
    } catch {
        return {};
    }
}

/**
 * Get credentials for a specific device, or the first available
 * @param {string} name - Optional device name
 * @returns {Object|null}
 */
function getCredentials(name) {
    const all = getAllCredentials();
    const keys = Object.keys(all);

    if (keys.length === 0) return null;

    if (name && all[name]) {
        return all[name];
    }

    // Return first available
    return all[keys[0]];
}

/**
 * Get the currently active credentials
 */
function getActiveCredentials() {
    try {
        const creds = localStorage.getItem(ACTIVE_CREDS_KEY);
        if (!creds || creds === 'false') return null;
        return JSON.parse(creds);
    } catch {
        return null;
    }
}

/**
 * Set the active credentials
 */
function setActiveCredentials(creds) {
    localStorage.setItem(ACTIVE_CREDS_KEY, JSON.stringify(creds));
}

/**
 * Get list of saved device names
 */
function getSavedDeviceNames() {
    return Object.keys(getAllCredentials());
}

/**
 * Check if we have valid credentials stored
 */
function hasValidCredentials() {
    const creds = getActiveCredentials();
    if (!creds) return false;

    return Boolean(creds.companion || creds.Companion);
}

module.exports = {
    // Scanning
    scan,
    lookupByIp,

    // Pairing
    startPair,
    finishPair1,
    finishPair2,

    // Connection
    connect,
    connectWithRetry,
    disconnect,
    isConnected,

    // Commands
    sendKey,
    getKeyboardFocus,
    getText,
    setText,

    // Credentials
    saveCredentials,
    getAllCredentials,
    getCredentials,
    getActiveCredentials,
    setActiveCredentials,
    getSavedDeviceNames,
    hasValidCredentials,

    // Events
    events
};
