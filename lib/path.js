// path.js - nikicat's module
// author: nikicat

var file = require('file');

function join(base) {
    return file.join.apply(null, arguments);
}

exports.join = join;