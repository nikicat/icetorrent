// http.js - nikicat's module
// author: nikicat

var {XMLHttpRequest} = require("xhr");
var {EventEmitter} = require("events");
var {Cc, Ci, Cr, Cu} = require("chrome");
var NetUtil = {};
Cu.import("resource://gre/modules/NetUtil.jsm", NetUtil);
NetUtil = NetUtil.NetUtil;

function ClientRequest(options, callback) {
    this.xhr = new XMLHttpRequest();
    this.uri = options.uri.spec;
    console.debug('creating XHR to '+this.uri);
    this.xhr.open(options.method, this.uri, true);
    for (header in options.headers) {
        this.xhr.setRequestHeader(header, options.headers[header]);
    }
    this.xhr._req.addEventListener("load", this.complete.bind(this));
    this.xhr._req.addEventListener("error", this.error.bind(this));
    this.xhr._req.addEventListener("progress", this.progress.bind(this));
    this.xhr._req.overrideMimeType("text/plain; charset=x-user-defined");
    if (callback)
        this.on("response", callback);
    this.body = '';
}

ClientRequest.prototype = {
    constructor: ClientRequest,
    complete: function (ev) {
        console.debug('request complete for '+this.uri);
        try {
            var resp = new exports.ClientResponse(this.xhr);
            this._emit("response", resp);
            resp.complete();
        } catch (e) {
            console.exception(e);
        }
    },
    error: function (ev) {
        console.debug('request error for '+this.uri+': '+this.xhr._req.status+' '+this.xhr._req.statusText);
        this._emit('error', ev);
    },
    progress: function (ev) {
        console.debug('request progress for '+this.uri+': '+ev.lengthComputable+' '+ev.loaded+'/'+ev.total);
    },
    write: function(data) {
        this.body += data;
    },
    end: function(data) {
        if (data)
            this.body += data;
        this.xhr.send(this.body);
    }
};

function ClientResponse(xhr) {
    this.xhr = xhr;
    this.headers = {}
    for (header in xhr.getAllResponseHeaders().split("\r\n")) {
        var [key, value] = header.split(":");
        this.headers[key] = value;
    }
}

ClientResponse.prototype = {
    constructor: ClientResponse,
    setEncoding: function(encoding) {
        this.encoding = encoding;
    },
    complete: function() {
        try {
            this._emit("data", this.xhr._req.responseText);
            this._emit("end");
        } catch (e) {
            console.exception(e);
        }
    },
    get statusCode() {
        return this.xhr.status;
    }
};

function request(options, callback) {
    return new exports.ClientRequest(options, callback);
}

function HttpError(statusCode) {
    this.statusCode = statusCode;
}

HttpError.prototype = {
    __proto__: Error.prototype
};

exports.ClientRequest = EventEmitter.compose(ClientRequest.prototype);
exports.ClientResponse = EventEmitter.compose(ClientResponse.prototype);
exports.request = request;
exports.HttpError = HttpError;
