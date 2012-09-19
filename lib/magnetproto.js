// udpproto.js - FireTorrent's module
// author: nikicat

'use strict';

const {Cc, Ci, Cr} = require('chrome');
const {Unknown, Factory} = require('xpcom');
const {Class} = require('heritage');
const {Logged} = require('./log');
const {MagnetLoader} = require('./magnet');

const Protocol = Class({
    extends: Unknown,
    implements: [Logged],
    interfaces: [Ci.nsIProtocolHandler],
    scheme: 'magnet',
    protocolFlags: Ci.nsIProtocolHandler.URI_NORELATIVE,

    allowPort: function(port, scheme) {
        return false;
    },
    tag: 'magnet',
    name: 'Protocol',

    newURI: function(spec, charset, baseURI) { 
        try {
            var uri = Cc["@mozilla.org/network/standard-url;1"].createInstance(Ci.nsIStandardURL);
            this.debug('creating url from '+spec+' and '+baseURI);
            uri.init(1, -1, spec, null, baseURI);
            return uri.QueryInterface(Ci.nsIURI);
        } catch (e) {
            console.exception(e);
            throw e;
        }
    },

    newChannel: function(uri) {
        try {
            this.debug('creating channel from uri '+uri.spec);
            return Channel(uri.QueryInterface(Ci.nsIURL));
        } catch (e) {
            console.exception(e);
            throw e;
        }
     }
});

let Channel = Class({
    name: 'MagnetChannel',
    extends: Unknown,
    interfaces: [Ci.nsIChannel],
    implements: [Logged],
    initialize: function(uri) {
        this.loader = new MagnetLoader(uri);
        this.tag = uri.spec.substring(9, 19);
        let channel = Cc['@mozilla.org/network/input-stream-channel;1'].createInstance(Ci.nsIInputStreamChannel);
        channel.setURI(uri);
        this.channel = channel.QueryInterface(Ci.nsIChannel);

        let pipe = Cc['@mozilla.org/pipe;1'].createInstance(Ci.nsIPipe);
        pipe.init(true, false, 0, 0xffffffff, null);
        this.out = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
        this.out.setOutputStream(pipe.outputStream);
        this.channel.contentStream = pipe.inputStream;
    },
    __noSuchMethod__: function(id, args) {
        if (typeof this.channel[id] == 'function') {
            this.channel[id].apply(this.channel, args);
        }
    },
    asyncOpen: function(listener, context) {
        try {
            this.loader.load((function(metadata) {
                this.debug('torrent loaded from magnet link');
                this.channel.contentLength = metadata.length; 
                this.channel.asyncOpen(listener, context);
                this.out.writeByteArray(metadata, metadata.length);
                this.out.close();
            }).bind(this));
        } catch (e) {
            this.error(e);
        }
    }
});

// Create and register factory
console.debug('registering magnet protocol factory');
Factory({
    Component: Protocol,
    contract: '@mozilla.org/network/protocol;1?name=magnet',
});
