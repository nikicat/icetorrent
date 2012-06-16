// url.js - FireTorrent's module
// author: nikicat

var {Cc, Ci} = require('chrome');
var ios = Cc["@mozilla.org/network/io-service;1"].getService(Ci.nsIIOService);

function URL(spec, base) {
    return ios.newURI(spec, null, base).QueryInterface(Ci.nsIURL);
}

exports.URL = URL;