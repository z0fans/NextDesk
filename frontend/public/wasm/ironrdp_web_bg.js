export class ClipboardData {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ClipboardData.prototype);
        obj.__wbg_ptr = ptr;
        ClipboardDataFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ClipboardDataFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_clipboarddata_free(ptr, 0);
    }
    /**
     * @param {string} mime_type
     * @param {Uint8Array} binary
     */
    addBinary(mime_type, binary) {
        const ptr0 = passStringToWasm0(mime_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(binary, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.clipboarddata_addBinary(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * @param {string} mime_type
     * @param {string} text
     */
    addText(mime_type, text) {
        const ptr0 = passStringToWasm0(mime_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.clipboarddata_addText(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    constructor() {
        const ret = wasm.clipboarddata_create();
        this.__wbg_ptr = ret >>> 0;
        ClipboardDataFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {boolean}
     */
    isEmpty() {
        const ret = wasm.clipboarddata_isEmpty(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {ClipboardItem[]}
     */
    items() {
        const ret = wasm.clipboarddata_items(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) ClipboardData.prototype[Symbol.dispose] = ClipboardData.prototype.free;

export class ClipboardItem {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ClipboardItem.prototype);
        obj.__wbg_ptr = ptr;
        ClipboardItemFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ClipboardItemFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_clipboarditem_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    mimeType() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.clipboarditem_mimeType(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {any}
     */
    value() {
        const ret = wasm.clipboarditem_value(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) ClipboardItem.prototype[Symbol.dispose] = ClipboardItem.prototype.free;

export class DesktopSize {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(DesktopSize.prototype);
        obj.__wbg_ptr = ptr;
        DesktopSizeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DesktopSizeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_desktopsize_free(ptr, 0);
    }
    /**
     * @param {number} width
     * @param {number} height
     */
    constructor(width, height) {
        const ret = wasm.desktopsize_create(width, height);
        this.__wbg_ptr = ret >>> 0;
        DesktopSizeFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.__wbg_get_desktopsize_height(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.__wbg_get_desktopsize_width(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set height(arg0) {
        wasm.__wbg_set_desktopsize_height(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set width(arg0) {
        wasm.__wbg_set_desktopsize_width(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) DesktopSize.prototype[Symbol.dispose] = DesktopSize.prototype.free;

export class DeviceEvent {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(DeviceEvent.prototype);
        obj.__wbg_ptr = ptr;
        DeviceEventFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DeviceEventFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_deviceevent_free(ptr, 0);
    }
    /**
     * @param {number} scancode
     * @returns {DeviceEvent}
     */
    static keyPressed(scancode) {
        const ret = wasm.deviceevent_keyPressed(scancode);
        return DeviceEvent.__wrap(ret);
    }
    /**
     * @param {number} scancode
     * @returns {DeviceEvent}
     */
    static keyReleased(scancode) {
        const ret = wasm.deviceevent_keyReleased(scancode);
        return DeviceEvent.__wrap(ret);
    }
    /**
     * @param {number} button
     * @returns {DeviceEvent}
     */
    static mouseButtonPressed(button) {
        const ret = wasm.deviceevent_mouseButtonPressed(button);
        return DeviceEvent.__wrap(ret);
    }
    /**
     * @param {number} button
     * @returns {DeviceEvent}
     */
    static mouseButtonReleased(button) {
        const ret = wasm.deviceevent_mouseButtonReleased(button);
        return DeviceEvent.__wrap(ret);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @returns {DeviceEvent}
     */
    static mouseMove(x, y) {
        const ret = wasm.deviceevent_mouseMove(x, y);
        return DeviceEvent.__wrap(ret);
    }
    /**
     * @param {string} unicode
     * @returns {DeviceEvent}
     */
    static unicodePressed(unicode) {
        const char0 = unicode.codePointAt(0);
        _assertChar(char0);
        const ret = wasm.deviceevent_unicodePressed(char0);
        return DeviceEvent.__wrap(ret);
    }
    /**
     * @param {string} unicode
     * @returns {DeviceEvent}
     */
    static unicodeReleased(unicode) {
        const char0 = unicode.codePointAt(0);
        _assertChar(char0);
        const ret = wasm.deviceevent_unicodeReleased(char0);
        return DeviceEvent.__wrap(ret);
    }
    /**
     * @param {boolean} vertical
     * @param {number} rotation_amount
     * @param {RotationUnit} rotation_unit
     * @returns {DeviceEvent}
     */
    static wheelRotations(vertical, rotation_amount, rotation_unit) {
        const ret = wasm.deviceevent_wheelRotations(vertical, rotation_amount, rotation_unit);
        return DeviceEvent.__wrap(ret);
    }
}
if (Symbol.dispose) DeviceEvent.prototype[Symbol.dispose] = DeviceEvent.prototype.free;

export class Extension {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ExtensionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_extension_free(ptr, 0);
    }
    /**
     * @param {string} ident
     * @param {any} value
     */
    constructor(ident, value) {
        const ptr0 = passStringToWasm0(ident, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.extension_create(ptr0, len0, value);
        this.__wbg_ptr = ret >>> 0;
        ExtensionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) Extension.prototype[Symbol.dispose] = Extension.prototype.free;

export class InputTransaction {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        InputTransactionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_inputtransaction_free(ptr, 0);
    }
    /**
     * @param {DeviceEvent} event
     */
    addEvent(event) {
        _assertClass(event, DeviceEvent);
        var ptr0 = event.__destroy_into_raw();
        wasm.inputtransaction_addEvent(this.__wbg_ptr, ptr0);
    }
    constructor() {
        const ret = wasm.inputtransaction_create();
        this.__wbg_ptr = ret >>> 0;
        InputTransactionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) InputTransaction.prototype[Symbol.dispose] = InputTransaction.prototype.free;

export class IronError {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(IronError.prototype);
        obj.__wbg_ptr = ptr;
        IronErrorFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IronErrorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ironerror_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    backtrace() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.ironerror_backtrace(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {IronErrorKind}
     */
    kind() {
        const ret = wasm.ironerror_kind(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {RDCleanPathDetails | undefined}
     */
    rdcleanpathDetails() {
        const ret = wasm.ironerror_rdcleanpathDetails(this.__wbg_ptr);
        return ret === 0 ? undefined : RDCleanPathDetails.__wrap(ret);
    }
}
if (Symbol.dispose) IronError.prototype[Symbol.dispose] = IronError.prototype.free;

/**
 * @enum {0 | 1 | 2 | 3 | 4 | 5 | 6}
 */
export const IronErrorKind = Object.freeze({
    /**
     * Catch-all error kind
     */
    General: 0, "0": "General",
    /**
     * Incorrect password used
     */
    WrongPassword: 1, "1": "WrongPassword",
    /**
     * Unable to login to machine
     */
    LogonFailure: 2, "2": "LogonFailure",
    /**
     * Insufficient permission, server denied access
     */
    AccessDenied: 3, "3": "AccessDenied",
    /**
     * Something wrong happened when sending or receiving the RDCleanPath message
     */
    RDCleanPath: 4, "4": "RDCleanPath",
    /**
     * Couldn't connect to proxy
     */
    ProxyConnect: 5, "5": "ProxyConnect",
    /**
     * Protocol negotiation failed
     */
    NegotiationFailure: 6, "6": "NegotiationFailure",
});

/**
 * Detailed error information for RDCleanPath errors.
 *
 * When an RDCleanPath error occurs, this structure provides granular details
 * about the underlying cause, including HTTP status codes, Windows Socket errors,
 * and TLS alert codes.
 */
export class RDCleanPathDetails {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(RDCleanPathDetails.prototype);
        obj.__wbg_ptr = ptr;
        RDCleanPathDetailsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RDCleanPathDetailsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rdcleanpathdetails_free(ptr, 0);
    }
    /**
     * HTTP status code if the error originated from an HTTP response.
     *
     * Common values:
     * - 403: Forbidden (e.g., deleted VNET, insufficient permissions)
     * - 404: Not Found
     * - 500: Internal Server Error
     * - 502: Bad Gateway
     * - 503: Service Unavailable
     * @returns {number | undefined}
     */
    get httpStatusCode() {
        const ret = wasm.rdcleanpathdetails_httpStatusCode(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret;
    }
    /**
     * TLS alert code if the error occurred during TLS handshake.
     *
     * Common values:
     * - 40: Handshake failure
     * - 42: Bad certificate
     * - 45: Certificate expired
     * - 48: Unknown CA
     * - 112: Unrecognized name
     * @returns {number | undefined}
     */
    get tlsAlertCode() {
        const ret = wasm.rdcleanpathdetails_tlsAlertCode(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret;
    }
    /**
     * Windows Socket API (WSA) error code.
     *
     * Common values:
     * - 10013: Permission denied (WSAEACCES) - often indicates deleted/invalid VNET
     * - 10060: Connection timed out (WSAETIMEDOUT)
     * - 10061: Connection refused (WSAECONNREFUSED)
     * - 10051: Network is unreachable (WSAENETUNREACH)
     * - 10065: No route to host (WSAEHOSTUNREACH)
     * @returns {number | undefined}
     */
    get wsaErrorCode() {
        const ret = wasm.rdcleanpathdetails_wsaErrorCode(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret;
    }
}
if (Symbol.dispose) RDCleanPathDetails.prototype[Symbol.dispose] = RDCleanPathDetails.prototype.free;

export class RdpFile {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RdpFileFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rdpfile_free(ptr, 0);
    }
    constructor() {
        const ret = wasm.rdpfile_create();
        this.__wbg_ptr = ret >>> 0;
        RdpFileFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {string} key
     * @returns {number | undefined}
     */
    getInt(key) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rdpfile_getInt(this.__wbg_ptr, ptr0, len0);
        return ret === 0x100000001 ? undefined : ret;
    }
    /**
     * @param {string} key
     * @returns {string | undefined}
     */
    getStr(key) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rdpfile_getStr(this.__wbg_ptr, ptr0, len0);
        let v2;
        if (ret[0] !== 0) {
            v2 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * @param {string} key
     * @param {number} value
     */
    insertInt(key, value) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rdpfile_insertInt(this.__wbg_ptr, ptr0, len0, value);
    }
    /**
     * @param {string} key
     * @param {string} value
     */
    insertStr(key, value) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.rdpfile_insertStr(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * @param {string} config
     */
    parse(config) {
        const ptr0 = passStringToWasm0(config, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rdpfile_parse(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @returns {string}
     */
    write() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.rdpfile_write(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) RdpFile.prototype[Symbol.dispose] = RdpFile.prototype.free;

/**
 * @enum {0 | 1 | 2}
 */
export const RotationUnit = Object.freeze({
    Pixel: 0, "0": "Pixel",
    Line: 1, "1": "Line",
    Page: 2, "2": "Page",
});

export class Session {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Session.prototype);
        obj.__wbg_ptr = ptr;
        SessionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_session_free(ptr, 0);
    }
    /**
     * @param {InputTransaction} transaction
     */
    applyInputs(transaction) {
        _assertClass(transaction, InputTransaction);
        var ptr0 = transaction.__destroy_into_raw();
        const ret = wasm.session_applyInputs(this.__wbg_ptr, ptr0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {DesktopSize}
     */
    desktopSize() {
        const ret = wasm.session_desktopSize(this.__wbg_ptr);
        return DesktopSize.__wrap(ret);
    }
    /**
     * @param {Extension} ext
     * @returns {any}
     */
    invokeExtension(ext) {
        _assertClass(ext, Extension);
        var ptr0 = ext.__destroy_into_raw();
        const ret = wasm.session_invokeExtension(this.__wbg_ptr, ptr0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {ClipboardData} content
     * @returns {Promise<void>}
     */
    onClipboardPaste(content) {
        _assertClass(content, ClipboardData);
        const ret = wasm.session_onClipboardPaste(this.__wbg_ptr, content.__wbg_ptr);
        return ret;
    }
    releaseAllInputs() {
        const ret = wasm.session_releaseAllInputs(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} width
     * @param {number} height
     * @param {number | null} [scale_factor]
     * @param {number | null} [physical_width]
     * @param {number | null} [physical_height]
     */
    resize(width, height, scale_factor, physical_width, physical_height) {
        wasm.session_resize(this.__wbg_ptr, width, height, isLikeNone(scale_factor) ? 0x100000001 : (scale_factor) >>> 0, isLikeNone(physical_width) ? 0x100000001 : (physical_width) >>> 0, isLikeNone(physical_height) ? 0x100000001 : (physical_height) >>> 0);
    }
    /**
     * @returns {Promise<SessionTerminationInfo>}
     */
    run() {
        const ret = wasm.session_run(this.__wbg_ptr);
        return ret;
    }
    shutdown() {
        const ret = wasm.session_shutdown(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {boolean}
     */
    supportsUnicodeKeyboardShortcuts() {
        const ret = wasm.session_supportsUnicodeKeyboardShortcuts(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {boolean} scroll_lock
     * @param {boolean} num_lock
     * @param {boolean} caps_lock
     * @param {boolean} kana_lock
     */
    synchronizeLockKeys(scroll_lock, num_lock, caps_lock, kana_lock) {
        const ret = wasm.session_synchronizeLockKeys(this.__wbg_ptr, scroll_lock, num_lock, caps_lock, kana_lock);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) Session.prototype[Symbol.dispose] = Session.prototype.free;

export class SessionBuilder {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SessionBuilder.prototype);
        obj.__wbg_ptr = ptr;
        SessionBuilderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SessionBuilderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sessionbuilder_free(ptr, 0);
    }
    /**
     * @param {string} token
     * @returns {SessionBuilder}
     */
    authToken(token) {
        const ptr0 = passStringToWasm0(token, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionbuilder_authToken(this.__wbg_ptr, ptr0, len0);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {Function} callback
     * @returns {SessionBuilder}
     */
    canvasResizedCallback(callback) {
        const ret = wasm.sessionbuilder_canvasResizedCallback(this.__wbg_ptr, callback);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @returns {Promise<Session>}
     */
    connect() {
        const ret = wasm.sessionbuilder_connect(this.__wbg_ptr);
        return ret;
    }
    constructor() {
        const ret = wasm.sessionbuilder_create();
        this.__wbg_ptr = ret >>> 0;
        SessionBuilderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {DesktopSize} desktop_size
     * @returns {SessionBuilder}
     */
    desktopSize(desktop_size) {
        _assertClass(desktop_size, DesktopSize);
        var ptr0 = desktop_size.__destroy_into_raw();
        const ret = wasm.sessionbuilder_desktopSize(this.__wbg_ptr, ptr0);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {string} destination
     * @returns {SessionBuilder}
     */
    destination(destination) {
        const ptr0 = passStringToWasm0(destination, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionbuilder_destination(this.__wbg_ptr, ptr0, len0);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {Extension} ext
     * @returns {SessionBuilder}
     */
    extension(ext) {
        _assertClass(ext, Extension);
        var ptr0 = ext.__destroy_into_raw();
        const ret = wasm.sessionbuilder_extension(this.__wbg_ptr, ptr0);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {Function} callback
     * @returns {SessionBuilder}
     */
    fileContentsRequestCallback(callback) {
        const ret = wasm.sessionbuilder_fileContentsRequestCallback(this.__wbg_ptr, callback);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {Function} callback
     * @returns {SessionBuilder}
     */
    fileContentsResponseCallback(callback) {
        const ret = wasm.sessionbuilder_fileContentsResponseCallback(this.__wbg_ptr, callback);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {Function} callback
     * @returns {SessionBuilder}
     */
    forceClipboardUpdateCallback(callback) {
        const ret = wasm.sessionbuilder_forceClipboardUpdateCallback(this.__wbg_ptr, callback);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {string} password
     * @returns {SessionBuilder}
     */
    password(password) {
        const ptr0 = passStringToWasm0(password, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionbuilder_password(this.__wbg_ptr, ptr0, len0);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {string} address
     * @returns {SessionBuilder}
     */
    proxyAddress(address) {
        const ptr0 = passStringToWasm0(address, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionbuilder_proxyAddress(this.__wbg_ptr, ptr0, len0);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {Function} callback
     * @returns {SessionBuilder}
     */
    remoteClipboardChangedCallback(callback) {
        const ret = wasm.sessionbuilder_remoteClipboardChangedCallback(this.__wbg_ptr, callback);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {HTMLCanvasElement} canvas
     * @returns {SessionBuilder}
     */
    renderCanvas(canvas) {
        const ret = wasm.sessionbuilder_renderCanvas(this.__wbg_ptr, canvas);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {string} server_domain
     * @returns {SessionBuilder}
     */
    serverDomain(server_domain) {
        const ptr0 = passStringToWasm0(server_domain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionbuilder_serverDomain(this.__wbg_ptr, ptr0, len0);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {Function} callback
     * @returns {SessionBuilder}
     */
    setCursorStyleCallback(callback) {
        const ret = wasm.sessionbuilder_setCursorStyleCallback(this.__wbg_ptr, callback);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {any} context
     * @returns {SessionBuilder}
     */
    setCursorStyleCallbackContext(context) {
        const ret = wasm.sessionbuilder_setCursorStyleCallbackContext(this.__wbg_ptr, context);
        return SessionBuilder.__wrap(ret);
    }
    /**
     * @param {string} username
     * @returns {SessionBuilder}
     */
    username(username) {
        const ptr0 = passStringToWasm0(username, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionbuilder_username(this.__wbg_ptr, ptr0, len0);
        return SessionBuilder.__wrap(ret);
    }
}
if (Symbol.dispose) SessionBuilder.prototype[Symbol.dispose] = SessionBuilder.prototype.free;

export class SessionTerminationInfo {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SessionTerminationInfo.prototype);
        obj.__wbg_ptr = ptr;
        SessionTerminationInfoFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SessionTerminationInfoFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sessionterminationinfo_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    reason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sessionterminationinfo_reason(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) SessionTerminationInfo.prototype[Symbol.dispose] = SessionTerminationInfo.prototype.free;

/**
 * @param {string} log_level
 */
export function setup(log_level) {
    const ptr0 = passStringToWasm0(log_level, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.setup(ptr0, len0);
}
export function __wbg_Error_83742b46f01ce22d(arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return ret;
}
export function __wbg___wbindgen_boolean_get_c0f3f60bac5a78d1(arg0) {
    const v = arg0;
    const ret = typeof(v) === 'boolean' ? v : undefined;
    return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
}
export function __wbg___wbindgen_debug_string_5398f5bb970e0daa(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_is_function_3c846841762788c1(arg0) {
    const ret = typeof(arg0) === 'function';
    return ret;
}
export function __wbg___wbindgen_is_string_7ef6b97b02428fae(arg0) {
    const ret = typeof(arg0) === 'string';
    return ret;
}
export function __wbg___wbindgen_is_undefined_52709e72fb9f179c(arg0) {
    const ret = arg0 === undefined;
    return ret;
}
export function __wbg___wbindgen_number_get_34bb9d9dcfa21373(arg0, arg1) {
    const obj = arg1;
    const ret = typeof(obj) === 'number' ? obj : undefined;
    getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
}
export function __wbg___wbindgen_string_get_395e606bd0ee4427(arg0, arg1) {
    const obj = arg1;
    const ret = typeof(obj) === 'string' ? obj : undefined;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_throw_6ddd609b62940d55(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbg__wbg_cb_unref_6b5b6b8576d35cb1(arg0) {
    arg0._wbg_cb_unref();
}
export function __wbg_addEventListener_2d985aa8a656f6dc() { return handleError(function (arg0, arg1, arg2, arg3) {
    arg0.addEventListener(getStringFromWasm0(arg1, arg2), arg3);
}, arguments); }
export function __wbg_addEventListener_97281b0177d72360() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
    arg0.addEventListener(getStringFromWasm0(arg1, arg2), arg3, arg4);
}, arguments); }
export function __wbg_apply_ac9afb97ca32f169() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.apply(arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_arrayBuffer_eb8e9ca620af2a19() { return handleError(function (arg0) {
    const ret = arg0.arrayBuffer();
    return ret;
}, arguments); }
export function __wbg_attachShader_e557f37438249ff7(arg0, arg1, arg2) {
    arg0.attachShader(arg1, arg2);
}
export function __wbg_bindBuffer_142694a9732bc098(arg0, arg1, arg2) {
    arg0.bindBuffer(arg1 >>> 0, arg2);
}
export function __wbg_bindTexture_6a0892cd752b41d9(arg0, arg1, arg2) {
    arg0.bindTexture(arg1 >>> 0, arg2);
}
export function __wbg_bindVertexArray_c307251f3ff61930(arg0, arg1) {
    arg0.bindVertexArray(arg1);
}
export function __wbg_bufferData_d20232e3d5dcdc62(arg0, arg1, arg2, arg3) {
    arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
}
export function __wbg_call_2d781c1f4d5c0ef8() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.call(arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_call_e133b57c9155d22c() { return handleError(function (arg0, arg1) {
    const ret = arg0.call(arg1);
    return ret;
}, arguments); }
export function __wbg_call_f858478a02f9600f() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
    const ret = arg0.call(arg1, arg2, arg3, arg4);
    return ret;
}, arguments); }
export function __wbg_clearTimeout_113b1cde814ec762(arg0) {
    const ret = clearTimeout(arg0);
    return ret;
}
export function __wbg_clipboarddata_new(arg0) {
    const ret = ClipboardData.__wrap(arg0);
    return ret;
}
export function __wbg_clipboarditem_new(arg0) {
    const ret = ClipboardItem.__wrap(arg0);
    return ret;
}
export function __wbg_close_af26905c832a88cb() { return handleError(function (arg0) {
    arg0.close();
}, arguments); }
export function __wbg_code_aea376e2d265a64f(arg0) {
    const ret = arg0.code;
    return ret;
}
export function __wbg_compileShader_7ca66245c2798601(arg0, arg1) {
    arg0.compileShader(arg1);
}
export function __wbg_createBuffer_1aa34315dc9585a2(arg0) {
    const ret = arg0.createBuffer();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createProgram_1fa32901e4db13cd(arg0) {
    const ret = arg0.createProgram();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createShader_a00913b8c6489e6b(arg0, arg1) {
    const ret = arg0.createShader(arg1 >>> 0);
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createTask_6eb3a8b6dd2f87c9() { return handleError(function (arg0, arg1) {
    const ret = console.createTask(getStringFromWasm0(arg0, arg1));
    return ret;
}, arguments); }
export function __wbg_createTexture_9b1b4f40cab0097b(arg0) {
    const ret = arg0.createTexture();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_createVertexArray_420460898dc8d838(arg0) {
    const ret = arg0.createVertexArray();
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_data_a3d9ff9cdd801002(arg0) {
    const ret = arg0.data;
    return ret;
}
export function __wbg_debug_4b9b1a2d5972be57(arg0) {
    console.debug(arg0);
}
export function __wbg_dispatchEvent_29145a50abb697bc() { return handleError(function (arg0, arg1) {
    const ret = arg0.dispatchEvent(arg1);
    return ret;
}, arguments); }
export function __wbg_drawArrays_c20dedf441392005(arg0, arg1, arg2, arg3) {
    arg0.drawArrays(arg1 >>> 0, arg2, arg3);
}
export function __wbg_enableVertexAttribArray_60dadea3a00e104a(arg0, arg1) {
    arg0.enableVertexAttribArray(arg1 >>> 0);
}
export function __wbg_error_8d9a8e04cd1d3588(arg0) {
    console.error(arg0);
}
export function __wbg_error_a6fa202b58aa1cd3(arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        console.error(getStringFromWasm0(arg0, arg1));
    } finally {
        wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
    }
}
export function __wbg_eval_c311194bb27c7836() { return handleError(function (arg0, arg1) {
    const ret = eval(getStringFromWasm0(arg0, arg1));
    return ret;
}, arguments); }
export function __wbg_fetch_8d9b732df7467c44(arg0) {
    const ret = fetch(arg0);
    return ret;
}
export function __wbg_getContext_07270456453ee7f5() { return handleError(function (arg0, arg1, arg2, arg3) {
    const ret = arg0.getContext(getStringFromWasm0(arg1, arg2), arg3);
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}, arguments); }
export function __wbg_getProgramInfoLog_50443ddea7475f57(arg0, arg1, arg2) {
    const ret = arg1.getProgramInfoLog(arg2);
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_getProgramParameter_46e2d49878b56edd(arg0, arg1, arg2) {
    const ret = arg0.getProgramParameter(arg1, arg2 >>> 0);
    return ret;
}
export function __wbg_getRandomValues_3dda8830c2565714() { return handleError(function (arg0, arg1) {
    globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
}, arguments); }
export function __wbg_getRandomValues_3f44b700395062e5() { return handleError(function (arg0, arg1) {
    globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
}, arguments); }
export function __wbg_getShaderInfoLog_22f9e8c90a52f38d(arg0, arg1, arg2) {
    const ret = arg1.getShaderInfoLog(arg2);
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_getShaderParameter_46f64f7ca5d534db(arg0, arg1, arg2) {
    const ret = arg0.getShaderParameter(arg1, arg2 >>> 0);
    return ret;
}
export function __wbg_getTime_1dad7b5386ddd2d9(arg0) {
    const ret = arg0.getTime();
    return ret;
}
export function __wbg_getUniformLocation_5eb08673afa04eee(arg0, arg1, arg2, arg3) {
    const ret = arg0.getUniformLocation(arg1, getStringFromWasm0(arg2, arg3));
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_info_7d4e223bb1a7e671(arg0) {
    console.info(arg0);
}
export function __wbg_instanceof_ArrayBuffer_101e2bf31071a9f6(arg0) {
    let result;
    try {
        result = arg0 instanceof ArrayBuffer;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_Error_4691a5b466e32a80(arg0) {
    let result;
    try {
        result = arg0 instanceof Error;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_Response_9b4d9fd451e051b1(arg0) {
    let result;
    try {
        result = arg0 instanceof Response;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_instanceof_WebGl2RenderingContext_349f232f715e6bc2(arg0) {
    let result;
    try {
        result = arg0 instanceof WebGL2RenderingContext;
    } catch (_) {
        result = false;
    }
    const ret = result;
    return ret;
}
export function __wbg_ironerror_new(arg0) {
    const ret = IronError.__wrap(arg0);
    return ret;
}
export function __wbg_length_ea16607d7b61445b(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_linkProgram_b969f67969a850b5(arg0, arg1) {
    arg0.linkProgram(arg1);
}
export function __wbg_log_524eedafa26daa59(arg0) {
    console.log(arg0);
}
export function __wbg_message_00d63f20c41713dd(arg0) {
    const ret = arg0.message;
    return ret;
}
export function __wbg_name_ecf53d5e050a495d(arg0) {
    const ret = arg0.name;
    return ret;
}
export function __wbg_new_0837727332ac86ba() { return handleError(function () {
    const ret = new Headers();
    return ret;
}, arguments); }
export function __wbg_new_0_1dcafdf5e786e876() {
    const ret = new Date();
    return ret;
}
export function __wbg_new_227d7c05414eb861() {
    const ret = new Error();
    return ret;
}
export function __wbg_new_5415f704ce1c4eda() { return handleError(function () {
    const ret = new URLSearchParams();
    return ret;
}, arguments); }
export function __wbg_new_5f486cdf45a04d78(arg0) {
    const ret = new Uint8Array(arg0);
    return ret;
}
export function __wbg_new_a70fbab9066b301f() {
    const ret = new Array();
    return ret;
}
export function __wbg_new_ab79df5bd7c26067() {
    const ret = new Object();
    return ret;
}
export function __wbg_new_bb1018d527df73cb() { return handleError(function (arg0, arg1) {
    const ret = new URL(getStringFromWasm0(arg0, arg1));
    return ret;
}, arguments); }
export function __wbg_new_dd50bcc3f60ba434() { return handleError(function (arg0, arg1) {
    const ret = new WebSocket(getStringFromWasm0(arg0, arg1));
    return ret;
}, arguments); }
export function __wbg_new_from_slice_22da9388ac046e50(arg0, arg1) {
    const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
    return ret;
}
export function __wbg_new_typed_aaaeaf29cf802876(arg0, arg1) {
    try {
        var state0 = {a: arg0, b: arg1};
        var cb0 = (arg0, arg1) => {
            const a = state0.a;
            state0.a = 0;
            try {
                return wasm_bindgen__convert__closures_____invoke__hacfca932385cd16a(a, state0.b, arg0, arg1);
            } finally {
                state0.a = a;
            }
        };
        const ret = new Promise(cb0);
        return ret;
    } finally {
        state0.a = state0.b = 0;
    }
}
export function __wbg_new_typed_bccac67128ed885a() {
    const ret = new Array();
    return ret;
}
export function __wbg_new_with_event_init_dict_fb446c1d36e37046() { return handleError(function (arg0, arg1, arg2) {
    const ret = new CloseEvent(getStringFromWasm0(arg0, arg1), arg2);
    return ret;
}, arguments); }
export function __wbg_new_with_str_4c859c3e69e6cb15() { return handleError(function (arg0, arg1) {
    const ret = new Request(getStringFromWasm0(arg0, arg1));
    return ret;
}, arguments); }
export function __wbg_new_with_str_and_init_b4b54d1a819bc724() { return handleError(function (arg0, arg1, arg2) {
    const ret = new Request(getStringFromWasm0(arg0, arg1), arg2);
    return ret;
}, arguments); }
export function __wbg_now_16f0c993d5dd6c27() {
    const ret = Date.now();
    return ret;
}
export function __wbg_ok_7ec8b94facac7704(arg0) {
    const ret = arg0.ok;
    return ret;
}
export function __wbg_pixelStorei_2a2385ed59538d48(arg0, arg1, arg2) {
    arg0.pixelStorei(arg1 >>> 0, arg2);
}
export function __wbg_prototypesetcall_d62e5099504357e6(arg0, arg1, arg2) {
    Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
}
export function __wbg_push_e87b0e732085a946(arg0, arg1) {
    const ret = arg0.push(arg1);
    return ret;
}
export function __wbg_queueMicrotask_0c399741342fb10f(arg0) {
    const ret = arg0.queueMicrotask;
    return ret;
}
export function __wbg_queueMicrotask_a082d78ce798393e(arg0) {
    queueMicrotask(arg0);
}
export function __wbg_readyState_1f1e7f1bdf9f4d42(arg0) {
    const ret = arg0.readyState;
    return ret;
}
export function __wbg_reason_cbcb9911796c4714(arg0, arg1) {
    const ret = arg1.reason;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_removeEventListener_d27694700fc0df8b() { return handleError(function (arg0, arg1, arg2, arg3) {
    arg0.removeEventListener(getStringFromWasm0(arg1, arg2), arg3);
}, arguments); }
export function __wbg_resolve_ae8d83246e5bcc12(arg0) {
    const ret = Promise.resolve(arg0);
    return ret;
}
export function __wbg_run_78b7b601add6ed6b(arg0, arg1, arg2) {
    try {
        var state0 = {a: arg1, b: arg2};
        var cb0 = () => {
            const a = state0.a;
            state0.a = 0;
            try {
                return wasm_bindgen__convert__closures_____invoke__h2996e5dde8d0c330(a, state0.b, );
            } finally {
                state0.a = a;
            }
        };
        const ret = arg0.run(cb0);
        return ret;
    } finally {
        state0.a = state0.b = 0;
    }
}
export function __wbg_search_35617fb7936183df(arg0, arg1) {
    const ret = arg1.search;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_send_4a1dc66e8653e5ed() { return handleError(function (arg0, arg1, arg2) {
    arg0.send(getStringFromWasm0(arg1, arg2));
}, arguments); }
export function __wbg_send_d31a693c975dea74() { return handleError(function (arg0, arg1, arg2) {
    arg0.send(getArrayU8FromWasm0(arg1, arg2));
}, arguments); }
export function __wbg_session_new(arg0) {
    const ret = Session.__wrap(arg0);
    return ret;
}
export function __wbg_sessionterminationinfo_new(arg0) {
    const ret = SessionTerminationInfo.__wrap(arg0);
    return ret;
}
export function __wbg_setTimeout_ef24d2fc3ad97385() { return handleError(function (arg0, arg1) {
    const ret = setTimeout(arg0, arg1);
    return ret;
}, arguments); }
export function __wbg_set_282384002438957f(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
}
export function __wbg_set_6be42768c690e380(arg0, arg1, arg2) {
    arg0[arg1] = arg2;
}
export function __wbg_set_7eaa4f96924fd6b3() { return handleError(function (arg0, arg1, arg2) {
    const ret = Reflect.set(arg0, arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_set_binaryType_3dcf8281ec100a8f(arg0, arg1) {
    arg0.binaryType = __wbindgen_enum_BinaryType[arg1];
}
export function __wbg_set_body_a3d856b097dfda04(arg0, arg1) {
    arg0.body = arg1;
}
export function __wbg_set_code_fd32f14824f6885a(arg0, arg1) {
    arg0.code = arg1;
}
export function __wbg_set_e09648bea3f1af1e() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
    arg0.set(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
}, arguments); }
export function __wbg_set_headers_3c8fecc693b75327(arg0, arg1) {
    arg0.headers = arg1;
}
export function __wbg_set_height_b6548a01bdcb689a(arg0, arg1) {
    arg0.height = arg1 >>> 0;
}
export function __wbg_set_method_8c015e8bcafd7be1(arg0, arg1, arg2) {
    arg0.method = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_once_617be4b8bd597c38(arg0, arg1) {
    arg0.once = arg1 !== 0;
}
export function __wbg_set_reason_b5edb0791e7766e3(arg0, arg1, arg2) {
    arg0.reason = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_search_bd09fe57b201bac5(arg0, arg1, arg2) {
    arg0.search = getStringFromWasm0(arg1, arg2);
}
export function __wbg_set_width_c0fcaa2da53cd540(arg0, arg1) {
    arg0.width = arg1 >>> 0;
}
export function __wbg_shaderSource_2bca0edc97475e95(arg0, arg1, arg2, arg3) {
    arg0.shaderSource(arg1, getStringFromWasm0(arg2, arg3));
}
export function __wbg_stack_3b0d974bbf31e44f(arg0, arg1) {
    const ret = arg1.stack;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_static_accessor_GLOBAL_8adb955bd33fac2f() {
    const ret = typeof global === 'undefined' ? null : global;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_GLOBAL_THIS_ad356e0db91c7913() {
    const ret = typeof globalThis === 'undefined' ? null : globalThis;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_SELF_f207c857566db248() {
    const ret = typeof self === 'undefined' ? null : self;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_WINDOW_bb9f1ba69d61b386() {
    const ret = typeof window === 'undefined' ? null : window;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_statusText_bb47943caaee6050(arg0, arg1) {
    const ret = arg1.statusText;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_status_318629ab93a22955(arg0) {
    const ret = arg0.status;
    return ret;
}
export function __wbg_texImage2D_e173270e74e0a987() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
    arg0.texImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9 === 0 ? undefined : getArrayU8FromWasm0(arg9, arg10));
}, arguments); }
export function __wbg_texParameteri_f4b1596185f5432d(arg0, arg1, arg2, arg3) {
    arg0.texParameteri(arg1 >>> 0, arg2 >>> 0, arg3);
}
export function __wbg_texSubImage2D_d74f13c5ee17025a() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
    arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9 === 0 ? undefined : getArrayU8FromWasm0(arg9, arg10));
}, arguments); }
export function __wbg_then_098abe61755d12f6(arg0, arg1) {
    const ret = arg0.then(arg1);
    return ret;
}
export function __wbg_then_9e335f6dd892bc11(arg0, arg1, arg2) {
    const ret = arg0.then(arg1, arg2);
    return ret;
}
export function __wbg_toString_3272fa0dfd05dd87(arg0) {
    const ret = arg0.toString();
    return ret;
}
export function __wbg_toString_fca8b5e46235cfb4(arg0) {
    const ret = arg0.toString();
    return ret;
}
export function __wbg_uniform1i_953040fb972e9fab(arg0, arg1, arg2) {
    arg0.uniform1i(arg1, arg2);
}
export function __wbg_url_b6f96880b733816c(arg0, arg1) {
    const ret = arg1.url;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_useProgram_5405b431988b837b(arg0, arg1) {
    arg0.useProgram(arg1);
}
export function __wbg_vertexAttribPointer_ea73fc4cc5b7d647(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
    arg0.vertexAttribPointer(arg1 >>> 0, arg2, arg3 >>> 0, arg4 !== 0, arg5, arg6);
}
export function __wbg_viewport_b60aceadb9166023(arg0, arg1, arg2, arg3, arg4) {
    arg0.viewport(arg1, arg2, arg3, arg4);
}
export function __wbg_warn_69424c2d92a2fa73(arg0) {
    console.warn(arg0);
}
export function __wbg_wasClean_69f68dc4ed2d2cc7(arg0) {
    const ret = arg0.wasClean;
    return ret;
}
export function __wbindgen_cast_0000000000000001(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { dtor_idx: 1021, function: Function { arguments: [Externref], shim_idx: 4058, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__h8fe440f604e104d2, wasm_bindgen__convert__closures_____invoke__h7a927e59fec7d7c8);
    return ret;
}
export function __wbindgen_cast_0000000000000002(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { dtor_idx: 946, function: Function { arguments: [], shim_idx: 947, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__h8df8745fb9a5b601, wasm_bindgen__convert__closures_____invoke__hd42e1016a33d8c0c);
    return ret;
}
export function __wbindgen_cast_0000000000000003(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { dtor_idx: 985, function: Function { arguments: [], shim_idx: 986, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__h58834e42d23f55a7, wasm_bindgen__convert__closures_____invoke__h30c4bd7df154399c);
    return ret;
}
export function __wbindgen_cast_0000000000000004(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { dtor_idx: 988, function: Function { arguments: [NamedExternref("Event")], shim_idx: 989, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__h844e96d3b30ee2af, wasm_bindgen__convert__closures_____invoke__h12022c4de888092e);
    return ret;
}
export function __wbindgen_cast_0000000000000005(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { dtor_idx: 991, function: Function { arguments: [NamedExternref("CloseEvent")], shim_idx: 992, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__h7989cbc62c5d48fb, wasm_bindgen__convert__closures_____invoke__hcfdc1ca1fab71d90);
    return ret;
}
export function __wbindgen_cast_0000000000000006(arg0, arg1) {
    // Cast intrinsic for `Closure(Closure { dtor_idx: 994, function: Function { arguments: [NamedExternref("MessageEvent")], shim_idx: 995, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
    const ret = makeMutClosure(arg0, arg1, wasm.wasm_bindgen__closure__destroy__h1df606a35671af15, wasm_bindgen__convert__closures_____invoke__h2fb1f8b293b8fdcd);
    return ret;
}
export function __wbindgen_cast_0000000000000007(arg0) {
    // Cast intrinsic for `F64 -> Externref`.
    const ret = arg0;
    return ret;
}
export function __wbindgen_cast_0000000000000008(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(F32)) -> NamedExternref("Float32Array")`.
    const ret = getArrayF32FromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_0000000000000009(arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_000000000000000a(arg0) {
    // Cast intrinsic for `U64 -> Externref`.
    const ret = BigInt.asUintN(64, arg0);
    return ret;
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
function wasm_bindgen__convert__closures_____invoke__hd42e1016a33d8c0c(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__hd42e1016a33d8c0c(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__h30c4bd7df154399c(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__h30c4bd7df154399c(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__h2996e5dde8d0c330(arg0, arg1) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h2996e5dde8d0c330(arg0, arg1);
    return ret !== 0;
}

function wasm_bindgen__convert__closures_____invoke__h12022c4de888092e(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__h12022c4de888092e(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__hcfdc1ca1fab71d90(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__hcfdc1ca1fab71d90(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h2fb1f8b293b8fdcd(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__h2fb1f8b293b8fdcd(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h7a927e59fec7d7c8(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h7a927e59fec7d7c8(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__hacfca932385cd16a(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen__convert__closures_____invoke__hacfca932385cd16a(arg0, arg1, arg2, arg3);
}


const __wbindgen_enum_BinaryType = ["blob", "arraybuffer"];
const ClipboardDataFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_clipboarddata_free(ptr >>> 0, 1));
const ClipboardItemFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_clipboarditem_free(ptr >>> 0, 1));
const DesktopSizeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_desktopsize_free(ptr >>> 0, 1));
const DeviceEventFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_deviceevent_free(ptr >>> 0, 1));
const ExtensionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_extension_free(ptr >>> 0, 1));
const InputTransactionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_inputtransaction_free(ptr >>> 0, 1));
const IronErrorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ironerror_free(ptr >>> 0, 1));
const RDCleanPathDetailsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rdcleanpathdetails_free(ptr >>> 0, 1));
const RdpFileFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rdpfile_free(ptr >>> 0, 1));
const SessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_session_free(ptr >>> 0, 1));
const SessionBuilderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sessionbuilder_free(ptr >>> 0, 1));
const SessionTerminationInfoFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sessionterminationinfo_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertChar(c) {
    if (typeof(c) === 'number' && (c >= 0x110000 || (c >= 0xD800 && c < 0xE000))) throw new Error(`expected a valid Unicode scalar value, found ${c}`);
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => state.dtor(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, dtor, f) {
    const state = { a: arg0, b: arg1, cnt: 1, dtor };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            state.dtor(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
