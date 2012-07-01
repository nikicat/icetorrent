// udpproto.js - FireTorrent's module
// author: nikicat

const {Cc, Ci, Cr} = require('chrome');
const {Unknown, Factory} = require('xpcom');
const {Class, extend} = require('heritage');
const net = require('net');

const Protocol = Class({
  extends: Unknown,
  interfaces: [Ci.nsIProtocolHandler],
  scheme: 'udp',
  defaultPort: 80,
  protocolFlags: Ci.nsIProtocolHandler.URI_STD,

  allowPort: function(port, scheme) {
    return true;
  },

  newURI: function(spec, charset, baseURI) {
    var uri = Cc["@mozilla.org/network/standard-url;1"].createInstance(Ci.nsIStandardURL);
    console.debug('creating url from '+spec+' and '+baseURI);
    uri.init(1, -1, spec, null, baseURI);
    return uri.QueryInterface(Ci.nsIURI);
  },

  newChannel: function(uri) {
      throw new Error('this protocol implementation is a stub, does not support channel creation');
  }
});

// Create and register factory
console.debug('registering udpprotocol factory');
Factory({
    Component: Protocol,
    contract: '@mozilla.org/network/protocol;1?name=udp',
});
