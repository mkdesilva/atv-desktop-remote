/**
 * Views Module
 * Handles all DOM manipulation and view switching.
 * Subscribes to state changes and updates UI accordingly.
 */

const { States, appState } = require('./state');
const device = require('./device');

// View name to DOM element mapping
const viewElements = {
    [States.INIT]: '#initText',
    [States.SCANNING]: '#addNewElements',
    [States.PAIRING_1]: '#addNewElements',
    [States.PAIRING_2]: '#addNewElements',
    [States.CONNECTING]: '#runningElements',
    [States.CONNECTED]: '#runningElements'
};

// Track current view for cleanup
let currentView = null;

// Long press state (scoped to module)
let longPressTimers = {};
let isLongPressing = {};

/**
 * Initialize views module - subscribe to state changes
 */
function init() {
    appState.on('change', ({ newState, data }) => {
        showView(newState, data);
    });
}

/**
 * Show a specific view based on state
 * @param {string} state - The state/view to show
 * @param {Object} data - Optional data for the view
 */
function showView(state, data = {}) {
    // Hide all view containers first
    $('#initText').hide();
    $('#addNewElements').hide();
    $('#runningElements').hide();

    currentView = state;

    switch (state) {
        case States.INIT:
            showInitView();
            break;
        case States.SCANNING:
            showScanningView();
            break;
        case States.PAIRING_1:
        case States.PAIRING_2:
            showPairingView(data);
            break;
        case States.CONNECTING:
            showConnectingView(data);
            break;
        case States.CONNECTED:
            showConnectedView();
            break;
    }
}

/**
 * Show initialization view (loading spinner)
 */
function showInitView() {
    $('#initText').show();
}

/**
 * Show scanning view with loader
 */
function showScanningView() {
    $('#addNewElements').show();
    $('#loader').fadeIn();
    $('#pairingElements').hide();
    $('#pairCodeElements').hide();
    $('#topTextKBLink').hide();
    $('#atvDropdownContainer').html('');
    setStatus('Please wait, scanning...');
    $('#pairingLoader').html(getLoader());
}

/**
 * Show pairing view
 * @param {Object} data - Contains device info
 */
function showPairingView(data = {}) {
    $('#addNewElements').show();
    $('#loader').hide();
    $('#pairingElements').show();
    $('#results').hide();
    $('#pairCodeElements').show();
    $('#pairCode').val('').focus();
    $('#pairStepNum').html('1');
    $('#pairProtocolName').html('Companion');
}

/**
 * Show connecting view
 */
function showConnectingView(data = {}) {
    $('#runningElements').show();
    $('#pairingElements').hide();

    const retries = appState.connectRetries;
    if (retries > 0) {
        setStatus(`Connecting to ATV... (attempt ${retries + 1})`);
    } else {
        setStatus('Connecting to ATV...');
    }
}

/**
 * Show connected view with remote controls
 */
function showConnectedView() {
    $('#runningElements').show();
    $('#pairingElements').hide();
    $('#initText').hide();
    $('#statusText').hide();

    setupRemoteButtons();
    setupDeviceDropdown();
    setupKeyboardLink();
}

/**
 * Create device picker dropdown after scan
 * @param {string[]} devices - Array of device strings
 */
function createDevicePicker(devices) {
    $('#loader').hide();
    $('#statusText').hide();
    $('#pairingLoader').html('');
    $('#pairStepNum').html('1');
    $('#pairProtocolName').html('Companion');
    $('#pairingElements').show();

    const options = devices.map(el => ({ id: el, text: el }));
    options.unshift({ id: '', text: 'Select a device to pair' });

    // Destroy existing select2 if present
    if ($('#atv_picker').data('select2')) {
        $('#atv_picker').select2('destroy');
    }

    $('#atv_picker').select2({
        data: options,
        placeholder: 'Select a device to pair',
        dropdownAutoWidth: true,
        minimumResultsForSearch: Infinity
    }).off('change').on('change', () => {
        const selected = $('#atv_picker').val();
        if (selected) {
            appState.transition(States.PAIRING_1, { device: selected });
        }
    });
}

/**
 * Setup the remote control buttons with click and long-press handlers
 */
function setupRemoteButtons() {
    $('.directionTable').fadeIn();
    $('#topTextKBLink').show();

    // Clear previous handlers and state
    longPressTimers = {};
    isLongPressing = {};

    $('[data-key]').off('mousedown mouseup mouseleave');

    // Hold visuals are pure CSS (.pressing / .longpress-triggered in main.css)
    $('[data-key]').on('mousedown', function(e) {
        const key = $(this).data('key');
        const $button = $(this);

        clearTimeout(longPressTimers[key]);
        isLongPressing[key] = true;
        $button.addClass('pressing');

        longPressTimers[key] = setTimeout(() => {
            if (!isLongPressing[key]) return;

            $button.addClass('longpress-triggered');
            console.log(`Long press triggered for: ${key}`);
            window.sendCommand(key, true); // true indicates long press

            isLongPressing[key] = false;
            setTimeout(() => $button.removeClass('pressing longpress-triggered'), 200);
        }, 1000);
    });

    $('[data-key]').on('mouseup mouseleave', function(e) {
        const key = $(this).data('key');

        if (isLongPressing[key]) {
            clearTimeout(longPressTimers[key]);
            longPressTimers[key] = null;
            isLongPressing[key] = false;

            $(this).removeClass('pressing');

            if (e.type === 'mouseup') {
                console.log(`Regular click for: ${key}`);
                window.sendCommand(key, false);
            }
        }
    });

    // Show/hide keyboard link based on credentials
    const creds = device.getActiveCredentials();
    if (creds && (creds.Companion || creds.companion)) {
        $('#topTextHeader').hide();
        $('#topTextKBLink').show();
    } else {
        $('#topTextHeader').show();
        $('#topTextKBLink').hide();
    }
}

/**
 * Setup device dropdown in footer for switching between paired devices
 */
function setupDeviceDropdown() {
    const allCreds = device.getAllCredentials();
    const deviceNames = Object.keys(allCreds);
    const activeCreds = device.getActiveCredentials();

    let selectedIndex = 0;
    deviceNames.forEach((name, i) => {
        if (JSON.stringify(allCreds[name]) === JSON.stringify(activeCreds)) {
            selectedIndex = i;
        }
    });

    const options = deviceNames.map((name, i) => ({
        id: name,
        text: name,
        selected: i === selectedIndex
    }));

    options.unshift({ id: 'addnew', text: 'Pair another remote' });

    $('#atvDropdownContainer').html('<select id="remoteDropdown"></select>');

    $('#remoteDropdown').select2({
        data: options,
        placeholder: 'Select a remote',
        dropdownAutoWidth: true,
        minimumResultsForSearch: Infinity
    }).off('change').on('change', () => {
        const selected = $('#remoteDropdown').val();
        if (selected === 'addnew') {
            appState.transition(States.SCANNING);
        } else if (selected) {
            const creds = device.getCredentials(selected);
            device.setActiveCredentials(creds);
            appState.transition(States.CONNECTING, { credentials: creds });
        }
    });
}

/**
 * Setup keyboard link click handler
 */
function setupKeyboardLink() {
    $('#topTextKBLink a').off('click').on('click', (e) => {
        e.preventDefault();
        window.openKeyboard();
    });
}

/**
 * Set status text
 */
function setStatus(text) {
    $('#statusText').html(text).show();
}

/**
 * Show command feedback with fade animation
 */
function showCommandFeedback(text) {
    $('#cmdFade').html(text)
        .stop(true)
        .fadeOut(0)
        .css({ 'visibility': 'visible' })
        .fadeIn(200)
        .delay(800)
        .fadeOut(function() {
            $(this).css({ 'display': 'flex', 'visibility': 'hidden' });
        });
}

/**
 * Flash a button to indicate it was pressed
 */
function flashButton(key) {
    const el = $(`[data-key="${key}"]`);
    if (el.length > 0) {
        el.addClass('invert');
        setTimeout(() => el.removeClass('invert'), 500);
    }
}

/**
 * Toggle alt text visibility (for showing keyboard shortcuts)
 */
function toggleAltText(show) {
    if (show) {
        $('.keyText').show();
        $('.keyTextAlt').hide();
    } else {
        $('.keyText').hide();
        $('.keyTextAlt').show();
    }
}

/**
 * Get loader HTML
 */
function getLoader() {
    // This should match what's in loader.js
    return typeof window.getLoader === 'function' ? window.getLoader() : '';
}

module.exports = {
    init,
    showView,
    createDevicePicker,
    setStatus,
    showCommandFeedback,
    flashButton,
    toggleAltText,
    setupRemoteButtons
};
