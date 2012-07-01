// udpproto.js - FireTorrent's module
// author: nikicat

const {Cc, Ci, Cr} = require('chrome');
const {Unknown, Factory} = require('xpcom');
const {Class, extend} = require('heritage');
const net = require('net');
const {Torrent} = require('torrent');

const Protocol = Class({
    extends: Unknown,
    interfaces: [Ci.nsIProtocolHandler],
    scheme: 'magnet',
    protocolFlags: Ci.nsIProtocolHandler.URI_NORELATIVE,

    allowPort: function(port, scheme) {
        return false;
    },

    newURI: function(spec, charset, baseURI) { 
        try {
            var uri = Cc["@mozilla.org/network/standard-url;1"].createInstance(Ci.nsIStandardURL);
            console.debug('creating url from '+spec+' and '+baseURI);
            uri.init(1, -1, spec, null, baseURI);
            return uri.QueryInterface(Ci.nsIURI);
        } catch (e) {
            console.exception(e);
            throw e;
        }
    },

    newChannel: function(uri) {
        try {
            console.debug('creating channel from uri '+uri.spec);
            let channel = Cc['@mozilla.org/network/input-stream-channel;1'].createInstance(Ci.nsIInputStreamChannel);

            let pipe = Cc['@mozilla.org/pipe;1'].createInstance(Ci.nsIPipe);
            pipe.init(true, true, 0, 0xffffffff, null);
            let out = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
            out.setOutputStream(pipe.outputStream);
            channel.contentStream = pipe.inputStream;
            let torrent = Torrent();
            let written = 0;
            torrent.loadFromMagnet(uri.QueryInterface(Ci.nsIURL), function(error) {
                if (!error) {
                    console.debug('torrent loaded from magnet link');
                    torrent.checkFiles(function(error) {
                        if (!error) {
                            console.debug('torrent files checked');
                            torrent.start(function(data) {
                                if (data) {
                                    out.writeBytes(data, data.length);
                                } else {
                                    out.close();
                                }
                            }, progressive=true);
                        }
                    });
                }
            });
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
