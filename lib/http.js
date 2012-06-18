// http.js - nikicat's module
// author: nikicat

const {XMLHttpRequest} = require("xhr");
const {EventEmitter} = require("events");
const {Cc, Ci, Cr, Cu} = require("chrome");
const {Logged} = require('log');
const {Trait} = require('traits');
var NetUtil = {};
Cu.import("resource://gre/modules/NetUtil.jsm", NetUtil);
NetUtil = NetUtil.NetUtil;

const ClientRequest = Logged.compose(EventEmitter, {
    tag: null,
    constructor: function(options, callback) {
        this.xhr = new XMLHttpRequest();
        this.uri = options.uri.spec;
        this.tag = 'HttpRequest<'+options.uri.host+'>';
        this.debug('creating XHR');
        this.xhr.open(options.method, this.uri, true);
        for (header in options.headers) {
            this.xhr.setRequestHeader(header, options.headers[header]);
        }
        this.xhr._req.addEventListener("load", this.complete.bind(this));
        this.xhr._req.addEventListener("error", this._error.bind(this));
        this.xhr._req.addEventListener("progress", this.progress.bind(this));
        this.xhr._req.overrideMimeType("text/plain; charset=x-user-defined");
        if (callback)
            this.on("response", callback);
        this.body = '';
    },
    complete: function (ev) {
        this.debug('complete');
        try {
            var resp = ClientResponse(this.xhr);
            this._emit("response", resp);
            resp.complete();
        } catch (e) {
            this._error('exception while handling response: '+e);
            console.exception(e);
        }
    },
    _error: function (ev) {
        this.debug('error: '+ev+' status='+this.xhr._req.status+' ('+this.xhr._req.statusText+')');
        this._emit('error', ev);
    },
    progress: function (ev) {
        this.debug('progress: '+ev.lengthComputable+' '+ev.loaded+'/'+ev.total);
    },
    write: function(data) {
        this.body += data;
    },
    end: function(data) {
        if (data)
            this.body += data;
        this.xhr.send(this.body);
    }
});

const ClientResponse = Logged.compose(EventEmitter, {
    tag: null,
    constructor: function (xhr) {
        this.tag = 'HttpResponse<'+xhr._req.channel.URI.host+'>';
        this.xhr = xhr;
        this.headers = {}
        for (header in xhr.getAllResponseHeaders().split("\r\n")) {
            var [key, value] = header.split(":");
            this.headers[key] = value;
        }
    },
    setEncoding: function(encoding) {
        this.encoding = encoding;
    },
    complete: function() {
        this.debug('complete');
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
});

const HttpError = Trait.resolve({
    toString: '_toString'
}).compose(Error, {
    constructor: function(code) {
        this.statusCode = code;
    },
    statusCode: null,
    toString: function() {
        return 'HttpError<status='+this.statusCode+'>';
    }
});

exports.ClientRequest = ClientRequest;
exports.HttpError = HttpError;
