// fs.js - nikicat's module
// author: nikicat

'use strict';

const {Cc, Ci, Cr, Cu} = require("chrome");
var NetUtil = {};
Cu.import("resource://gre/modules/NetUtil.jsm", NetUtil);
NetUtil = NetUtil.NetUtil;
const bis = Cc["@mozilla.org/binaryinputstream;1"];
const bos = Cc["@mozilla.org/binaryoutputstream;1"];
const converter = Cc['@mozilla.org/intl/utf8converterservice;1'].getService(Ci.nsIUTF8ConverterService);
const InputStreamPump = Cc['@mozilla.org/network/input-stream-pump;1'];
const env = Cc["@mozilla.org/process/environment;1"].getService(Ci.nsIEnvironment);
const {Class} = require('heritage');
const {Unknown} = require('xpcom');
const {Logged,esc} = require('./log');

// Flags passed when opening a file.  See nsprpub/pr/include/prio.h.
const OPEN_FLAGS = {
  RDONLY: parseInt("0x01"),
  WRONLY: parseInt("0x02"),
  RDWR: parseInt("0x04"),
  CREATE_FILE: parseInt("0x08"),
  APPEND: parseInt("0x10"),
  TRUNCATE: parseInt("0x20"),
  SYNC: parseInt("0x40"),
  EXCL: parseInt("0x80")
};

const Stats = Class({
    implements: [Logged],
    initialize: function(pathorfile) {
        if (typeof(pathorfile) === 'string') {
            let utf8Path = converter.convertStringToUTF8(pathorfile, 'utf8', false, true);
            if (/^~\//.test(utf8Path)) {
                this.debug('replacing ~ with $HOME');
                utf8Path = env.get('HOME') + utf8Path.substring(1);
            }
            this.file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsILocalFile);
            this.file.initWithPath(utf8Path);
            for each (let arg in Array.prototype.slice.call(arguments, 1))
                this.file.append(arg);
        } else {
            this.file = pathorfile;
        }
    },
    get isDirectory () {
        return this.file.isDirectory();
    },
    get exists () {
        return this.file.exists();
    },
    get size () {
        return this.file.fileSize;
    },
    get path () {
        return this.file.path;
    },
    mkdir: function(permissions) {
        if (permissions === undefined)
            permissions = parseInt('775', 8);
        this.debug('creating directory '+this.path);
        this.file.create(Ci.nsIFile.DIRECTORY_TYPE, permissions); // u+rwx go+rx
    },
    open: function(mode, permissions) {
        if (permissions !== undefined)
            permissions = parseInt('666', 8);

        let openFlags = {};
        openFlags[undefined] = OPEN_FLAGS.RDONLY;
        openFlags['r'] = OPEN_FLAGS.RDONLY;
        openFlags['r+'] = OPEN_FLAGS.RDWR;
        openFlags['w'] = OPEN_FLAGS.WRONLY | OPEN_FLAGS.CREATE_FILE;
        openFlags['w+'] = OPEN_FLAGS.RDWR | OPEN_FLAGS.TRUNCATE | OPEN_FLAGS.CREATE_FILE;
        openFlags['a'] = OPEN_FLAGS.WRONLY | OPEN_FLAGS.CREATE_FILE | OPEN_FLAGS.APPEND;
        openFlags['a+'] = OPEN_FLAGS.RDWR | OPEN_FLAGS.CREATE_FILE | OPEN_FLAGS.APPEND;
        
        let stream = Cc['@mozilla.org/network/file-stream;1'].createInstance(Ci.nsIFileStream);
        stream.init(this.file, openFlags[mode], permissions, 0);
        return Stream(stream);
    },
    list: function() {
        let entries = this.file.directoryEntries;
        while(entries.hasMoreElements()) {
            let entry = entries.getNext();
            yield Stats(entry.QueryInterface(Ci.nsIFile));
        }
    },
    unlink: function() {
        this.file.remove(true);
    },
    append: function(part) {
        return this.file.append(part);
    }
});

const Stream = Class({
    implements: [Logged],
    initialize: function(stream) {
        this.stream = stream;
        this.input = stream.QueryInterface(Ci.nsIInputStream);
        this.output = stream.QueryInterface(Ci.nsIOutputStream);
        this.seekable = stream.QueryInterface(Ci.nsISeekableStream);
        this.binput = bis.createInstance(Ci.nsIBinaryInputStream);
        this.binput.setInputStream(this.input);
        this.boutput = bos.createInstance(Ci.nsIBinaryOutputStream);
        this.boutput.setOutputStream(this.output);
    },
    read: function(size) {
        if (size === undefined) {
            size = this.input.available();
        }
        this.debug('read '+size+' bytes');
        return this.binput.readBytes(size);
    },
    write: function(data) {
        return this.boutput.writeBytes(data, data.length);
    },
    seek: function(offset) {
        return this.seekable.seek(Ci.nsISeekableStream.NS_SEEK_SET, offset);
    },
    truncate: function(length) {
        this.seek(length);
        this.output.setEOF();
        this.seek(0);
    },
    close: function() {
        this.seekable.close();
        this.output.close();
    },
    available: function() {
        return this.input.available();
    }
});

function friendlyError(errOrResult, filename) {
    var isResult = typeof(errOrResult) === "number";
    var result = isResult ? errOrResult : errOrResult.result;
    switch (result) {
    case Cr.NS_ERROR_FILE_NOT_FOUND:
        return new Error("path does not exist: " + filename);
    }
    return isResult ? new Error("XPCOM error code: " + errOrResult) : errOrResult;
}

function stat(path, callback) {
    try {
        let stats = new Stats(path);
        callback(null, stats);
    } catch (e) {
        callback(e);
    }
}

function ensureExists(file) {
    if (!file.exists())
        throw friendlyError(Cr.NS_ERROR_FILE_NOT_FOUND, file.path);
}

function ensureDir(file) {
    ensureExists(file);
    if (!file.isDirectory())
        throw new Error("path is not a directory: " + file.path);
}

function ensureFile(file) {
    ensureExists(file);
    if (!file.isFile())
        throw new Error("path is not a file: " + file.path);
}

function truncate(stream, length, callback) {
    try {
        stream.truncate(length);
        callback(null);
    } catch (e) {
        callback(e);
    }
}

function readFile(path, mode, callback) {
    try {
        var _mode = 'r';
        open(path, _mode, null, function(e, stream) {
            if (e) {
                callback(e);
            } else {
                var contents = NetUtil.readInputStreamToString(stream.input, stream.available());
                callback(null, contents);
            }
        });
    } catch (e) {
        callback(e);
    }
}

exports.stat     = stat;
exports.readFile = readFile

exports.Stats = Stats;
exports.Stream = Stream;
