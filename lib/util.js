const bencode = require('bencode');
const cryptolib = require('crypto');

function computeHash(info) {
    let encoded = bencode.encode(info);
    let hash = new cryptolib.Hash('sha1');
    hash.update(encoded);
    return hash.digest('binary');
}

exports.computeHash = computeHash;
