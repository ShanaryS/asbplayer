const NULL = 0;
const SIZE_I32 = Uint32Array.BYTES_PER_ELEMENT;
const DEFAULT_ARGS = ['./ffmpeg', '-nostdin', '-y'];

Module['NULL'] = NULL;
Module['SIZE_I32'] = SIZE_I32;
Module['DEFAULT_ARGS'] = DEFAULT_ARGS;
Module['ret'] = -1;
Module['timeout'] = -1;
Module['logger'] = () => {};
Module['progress'] = () => {};

function stringToPtr(str) {
    const len = Module['lengthBytesUTF8'](str) + 1;
    const ptr = Module['_malloc'](len);
    Module['stringToUTF8'](str, ptr, len);
    return ptr;
}

function stringsToPtr(strs) {
    const ptr = Module['_malloc'](strs.length * SIZE_I32);
    for (let i = 0; i < strs.length; i++) {
        Module['setValue'](ptr + SIZE_I32 * i, stringToPtr(strs[i]), 'i32');
    }
    return ptr;
}

function exec(...args) {
    const command = [...Module['DEFAULT_ARGS'], ...args];
    try {
        Module['_ffmpeg'](command.length, stringsToPtr(command));
    } catch (error) {
        if (!error.message.startsWith('Aborted')) throw error;
    }
    return Module['ret'];
}

function asbLocateFile(path, prefix) {
    const mainScriptUrlOrBlob = Module['mainScriptUrlOrBlob'];
    if (mainScriptUrlOrBlob) {
        const encoded = mainScriptUrlOrBlob.slice(mainScriptUrlOrBlob.lastIndexOf('#') + 1);
        const { wasmURL, workerURL } = JSON.parse(atob(encoded));
        if (path.endsWith('.wasm')) return wasmURL;
        if (path.endsWith('.worker.js')) return workerURL;
    }
    return prefix + path;
}

Module['print'] = (message) => Module['logger']({ type: 'stdout', message });
Module['printErr'] = (message) => {
    if (!message.startsWith('Aborted(native code called abort())')) Module['logger']({ type: 'stderr', message });
};
Module['locateFile'] = asbLocateFile;
Module['exec'] = exec;
Module['setLogger'] = (logger) => {
    Module['logger'] = logger;
};
Module['setTimeout'] = (timeout) => {
    Module['timeout'] = timeout;
};
Module['setProgress'] = (handler) => {
    Module['progress'] = handler;
};
Module['receiveProgress'] = (progress, time) => Module['progress']({ progress, time });
Module['reset'] = () => {
    Module['ret'] = -1;
    Module['timeout'] = -1;
};
