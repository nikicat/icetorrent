// fs.js - nikicat's module
// author: nikicat

var {Cc, Ci, Cr, Cu} = require("chrome");
var NetUtil = {};
Cu.import("resource://gre/modules/NetUtil.jsm", NetUtil);
NetUtil = NetUtil.NetUtil;
var bis = Cc["@mozilla.org/binaryinputstream;1"];
var bos = Cc["@mozilla.org/binaryoutputstream;1"];
var converter = Cc['@mozilla.org/intl/utf8converterservice;1'].getService(Ci.nsIUTF8ConverterService);

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

function MozFile(path) {
    var utf8Path = converter.convertStringToUTF8(path, 'utf8', false, true);
    var file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsILocalFile);
    file.initWithPath(utf8Path);
    return file;
}

function Stats(path) {
    this.file = MozFile(path);
    this.path = path;
    this.size = this.file.fileSize;
};

Stats.prototype = {
    isDirectory: function () {
        return this.file.isDirectory();
    },
};

function Stream(stream) {
    this.stream = stream;
    this.input = stream.QueryInterface(Ci.nsIInputStream);
    this.output = stream.QueryInterface(Ci.nsIOutputStream);
    this.seekable = stream.QueryInterface(Ci.nsISeekableStream);
    this.binput = bis.createInstance(Ci.nsIBinaryInputStream);
    this.binput.setInputStream(this.input);
    this.boutput = bos.createInstance(Ci.nsIBinaryOutputStream);
    this.boutput.setOutputStream(this.output);
}

Stream.prototype = {
    read: function(length) {
        //return NetUtil.readInputStreamToString(this.input, length);
        return this.binput.readByteArray(length);
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
    },
    close: function() {
        this.seekable.close();
        this.output.close();
    },
    available: function() {
        return this.input.available();
    }
};

function friendlyError(errOrResult, filename) {
    var isResult = typeof(errOrResult) === "number";
    var result = isResult ? errOrResult : errOrResult.result;
    switch (result) {
    case Cr.NS_ERROR_FILE_NOT_FOUND:
        return new Error("path does not exist: " + filename);
    }
    return isResult ? new Error("XPCOM error code: " + errOrResult) : errOrResult;
}

function merge(obj1, obj2) {
    for (var attrname in obj2) {
        obj1[attrname] = obj2[attrname];
    }
    return obj1;
}

function stat(path, callback) {
    try {
        var stats = new Stats(path);
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

function unlink(path, callback) {
    var file = MozFile(path);
    ensureDir(file);
    try {
        file.remove(false);
        callback(null);
    }
    catch (err) {
        // Bug 566950 explains why we're not catching a specific exception here.
        callback(Error("The directory is not empty: " + path));
    }
}

function mkdir(path, mode, callback) {
    try {
        var file = MozFile(path);
        if (!file.exists())
            file.create(Ci.nsIFile.DIRECTORY_TYPE, mode); // u+rwx go+rx
        else if (!file.isDirectory())
            callback(Error("The path already exists and is not a directory: " + path));
        callback(null);
    } catch (e) {
        callback(e);
    }
}

function open(path, mode, permFlags, callback) {
    try {
        var file = MozFile(path);
        if (typeof(mode) !== "string")
            mode = "";
            
        if (typeof(permFlags) !== "number")
            permFlags = 0666;
            
        var openFlags = [];
        openFlags['r'] = OPEN_FLAGS.RDONLY;
        openFlags['r+'] = OPEN_FLAGS.RDWR;
        openFlags['w'] = OPEN_FLAGS.WRONLY | OPEN_FLAGS.CREATE_FILE;
        openFlags['w+'] = OPEN_FLAGS.RDWR | OPEN_FLAGS.TRUNCATE | OPEN_FLAGS.CREATE_FILE;
        openFlags['a'] = OPEN_FLAGS.WRONLY | OPEN_FLAGS.CREATE_FILE | OPEN_FLAGS.APPEND;
        openFlags['a+'] = OPEN_FLAGS.RDWR | OPEN_FLAGS.CREATE_FILE | OPEN_FLAGS.APPEND;
        
        var stream = Cc['@mozilla.org/network/file-stream;1'].createInstance(Ci.nsIFileStream);
        stream.init(file, openFlags[mode], permFlags, 0);
        callback(null, new Stream(stream));
    } catch (err) {
        callback(err, path);
    }
}

function truncate(stream, length, callback) {
    try {
        stream.truncate(length);
        callback(null);
    } catch (e) {
        callback(e);
    }
}

function close(stream, callback) {
    try {
        stream.close();
        callback(null);
    } catch (e) {
        callback(e);
    }
}

function read(stream, length, offset, mode, callback) {
    try {
        stream.seek(offset);
        var data = stream.read(length);
        callback(null, data, data.length);
    } catch (e) {
        callback(e);
    }
}

function write(stream, data, offset, mode, callback) {
    try {
        stream.seek(offset);
        var written = stream.write(data);
        callback(null, written);
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
exports.unlink   = unlink;
exports.mkdir    = mkdir;
exports.open     = open;
exports.truncate = truncate;
exports.close    = close;
exports.read     = read;
exports.write    = write;
exports.readFile = readFile
