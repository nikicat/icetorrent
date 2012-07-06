// udpproto.js - FireTorrent's module
// author: nikicat

'use strict';

const {Cc, Ci, Cr} = require('chrome');
const {Unknown, Factory} = require('xpcom');
const {Class, extend} = require('heritage');
const net = require('net');
const {Torrent} = require('torrent');
const {Logged} = require('log');

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
            let channel = Cc['@mozilla.org/network/input-stream-channel;1'].createInstance(Ci.nsIInputStreamChannel);

            let pipe = Cc['@mozilla.org/pipe;1'].createInstance(Ci.nsIPipe);
            pipe.init(true, false, 0, 0, null);//0xffffffff, null);
            let out = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
            out.setOutputStream(pipe.outputStream);
            channel.contentStream = pipe.inputStream;
            let torrent = Torrent();
            torrent.loadFromMagnet(uri.QueryInterface(Ci.nsIURL), (function(error) {
                if (!error) {
                    this.debug('torrent loaded from magnet link');
                    torrent.checkFiles((function(error) {
                        if (!error) {
                            this.debug('torrent files checked');
                            torrent.start(function(data) {
                                if (data !== null) {
                                    pipe.outputStream.write('asd', 3);
                                    out.writeByteArray(data, data.length);
                                } else {
                                    this.debug('closing stream');
                                    out.close();
                                }
                            }, true);
                        }
                    }).bind(this));
                }
            }).bind(this));
            return channel;
        } catch (e) {
            console.exception(e);
            throw e;
        }
     }
});

// Create and register factory
console.debug('registering magnet protocol factory');
Factory({
    Component: Protocol,
    contract: '@mozilla.org/network/protocol;1?name=magnet',
});
