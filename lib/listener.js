var net = require('net');
var peer = require('./peer');


function create(port, torrent){
    var state = 0, server = net.createServer(function(stream){
        console.log('createServer callback from '+stream.remoteAddress);
        var peerAddress = [0,0,0,0].map(function(){return Math.floor(Math.random()*255)}).join('.')+':'+Math.floor(6881 + Math.random()*100);
        torrent.peers[peerAddress] = peer.create(peerAddress, null, null, torrent, stream);
        
    });
    server.listen(port);
}

exports.create = create;