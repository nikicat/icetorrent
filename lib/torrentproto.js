// udpproto.js - FireTorrent's module
// author: nikicat

'use strict';

const {Cc, Ci, Cr, Cu, componenets} = require('chrome');
const {Unknown, Factory} = require('xpcom');
const {Class} = require('heritage');
const {Logged} = require('./log');
const {torrents} = require('./torrent');
const {MagnetLoader} = require('./magnet');
const {NetUtil} = Cu.import("resource://gre/modules/NetUtil.jsm");
const bencode = require('./bencode');

const Protocol = Class({
    extends: Unknown,
    implements: [Logged],
    interfaces: [Ci.nsIProtocolHandler],
    scheme: 'torrent',
    protocolFlags: Ci.nsIProtocolHandler.URI_NORELATIVE,

    allowPort: function(port, scheme) {
        return false;
    },
    tag: 'torrentproto',
    name: 'Protocol',

    newURI: function(spec, charset, baseURI) { 
        try {
            let uri = Cc['@mozilla.org/network/simple-uri;1'].createInstance(Ci.nsIURI);
            this.debug('creating url from '+spec);
            uri.spec = spec;
            return uri;
        } catch (e) {
            console.exception(e);
            throw e;
        }
    },

    newChannel: function(uri) {
        try {
            this.debug('creating channel from uri '+uri.spec);
            return Channel(uri);
        } catch (e) {
            console.exception(e);
            throw e;
        }
     }
});

let Channel = Class({
    name: 'TorrentChannel',
    extends: Unknown,
    interfaces: [Ci.nsIChannel],
    implements: [Logged],
    initialize: function(uri) {
        this.uri = uri;
        let subspec = uri.spec.slice(uri.spec.indexOf(':')+1, uri.spec.indexOf('!'));
        this.debug('create uri from '+subspec+'. full uri '+uri.spec);
        this.suburi = NetUtil.newURI(subspec).QueryInterface(Ci.nsIURL);
        let pathStart = uri.spec.indexOf('!') + 1;
        this.path = pathStart === 0 ? '' : encodeURIComponent(uri.spec.slice(pathStart));
        this.tag = this.suburi.spec.slice(0, 20);
        let channel = Cc['@mozilla.org/network/input-stream-channel;1'].createInstance(Ci.nsIInputStreamChannel);
        channel.setURI(uri);
        this.channel = channel.QueryInterface(Ci.nsIChannel);
        this.channel.originalURI = uri;

        let pipe = Cc['@mozilla.org/pipe;1'].createInstance(Ci.nsIPipe);
        pipe.init(true, false, 0, 0xffffffff, null);
        this.out = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
        this.out.setOutputStream(pipe.outputStream);
        this.channel.contentStream = pipe.inputStream;
    },
    __noSuchMethod__: function(id, args) {
        this.debug('__noSuchMethod__ '+id);
        if (typeof this.channel[id] === 'function') {
            this.channel[id].apply(this.channel, args);
        }
    },
    get URI () {
        return this.channel.URI;
    },
    get originalURI () {
        return this.channel.originalURI;
    },
    asyncOpen: function(listener, context) {
        try {
            this.debug('asyncOpen');
            NetUtil.asyncFetch(this.suburi, (function (istream, nsresult, request) {
                if (!components.isSuccessCode(nsresult)) {
                    this.error('failed to fetch torrent: '+nsresult);
                    return;
                }
                let binput = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
                binput.setInputStream(istream);
                let torrent = TorrentManager.load(binput.readBytes(istream.available()));
                this.debug('torrent loaded');
                let file = torrent.store.getFile(this.path);
                this.channel.contentLength = file.length;
                file.on('data', (function(data) {
                    this.debug('writing data '+data.length);
                    this.out.writeBytes(data, data.length);
                }).bind(this));
                file.on('end', (function() {
                    this.debug('closing stream');
                    this.out.close();
                }).bind(this));
                torrent.enableFile(this.path);
                torrent.start({ progressive: true });
            }).bind(this));
            this.channel.asyncOpen(listener, context);
        } catch (e) {
            this.error(e);
        }
    }
});

// Create and register factory
console.debug('registering torrent protocol factory');
Factory({
    Component: Protocol,
    contract: '@mozilla.org/network/protocol;1?name=torrent',
});
