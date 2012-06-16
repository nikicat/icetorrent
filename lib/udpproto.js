// udpproto.js - FireTorrent's module
// author: nikicat

const {Cc, Ci, Cr} = require('chrome');
const { Unknown, Factory } = require('xpcom');

const Protocol = Unknown.extend({
  interfaces: [Ci.nsIProtocolHandler],
  scheme: 'udp',
  defaultPort: 80,
  protocolFlags: Ci.nsIProtocolHandler.URI_STD,

  allowPort: function(port, scheme) {
    return true;
  },

  newURI: function(spec, charset, baseURI) {
    var uri = Cc["@mozilla.org/network/standard-url;1"].createInstance(Ci.nsIURI);
    uri.spec = spec;
    return uri;
  },

  newChannel: function(input_uri) {
    console.error('udpprotocol.newChannel is unsupported');
    throw Error("unsupported");
  }
});

// Create and register factory
console.debug('registering udpprotocol factory');
Factory.new({
    component: Protocol,
    contract: '@mozilla.org/network/protocol;1?name=udp',
});