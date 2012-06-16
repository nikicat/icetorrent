var bitfield = require('./bitfield');
var fs = require('fs');
var cryptolib = require('crypto');
var path = require('path');
var self = require('self');
var {Cu} = require("chrome");
var {ChromeWorker} = Cu.import("resource://gre/modules/Services.jsm", null);
var timer = require("timer");

function toHexString(charCode) {  
    return ("0" + charCode.toString(16)).slice(-2);  
}
function hashToHexString(hash) {
    return [toHexString(hash.charCodeAt(i)) for (i in hash)].join("");
}

// Find file that associates with offset
// returns index of file
function findFile(files, offset){
    var a = -1, b = files.length, c, file;
    while (a < b) {
        c = (a + b) >> 1;
        file = files[c];
        if (file.offset <= offset && file.offset + file.length > offset) {
            return c;
        }
        else 
            if (file.offset < offset) {
                a = c;
            }
            else {
                b = c;
            }
    }
    throw new Error('could not find file with offset '+offset);
}

// Returns an iterator object with two methods: hasNext() and next().
// Next will return {file, offset, length}
function createRangeIterator(files, offset, length){
    var i = findFile(files, offset);
    return {
        hasNext: function(){
            return length > 0;
        },
        next: function(){
            if (length <= 0) {
                throw Error("StopIteraton");
            }
            var file = files[i];
            var fileOffset = offset - file.offset;
            var fileLength = Math.min(file.length - fileOffset, length);
            i += 1;
            length -= fileLength;
            offset += fileLength;
            return {
                file: file,
                offset: fileOffset,
                length: fileLength
            };
        }
    };
}


function Store(metaInfo, destDir) {
    this.pieceLength = metaInfo['piece length'];
    this.pieces = metaInfo.pieces;
    if (!('info' in metaInfo))
        throw Error('no info found in metaInfo');

    var info = metaInfo.info;
    if (!('pieces' in info))
        throw Error('missing pieces');

    this.pieces = info.pieces;
    if (!('piece length' in info))
        throw Error('missing piece length');

    this.pieceLength = info['piece length'];
    
    // Check if this is a single file torrent or a file list torrent
    if ('length' in info) {
        // single file
        this.files = [{
            path: path.join(destDir, info.name),
            offset: 0,
            length: info.length,
            md5: info.md5
        }];
        this.totalLength = info.length;
    }
    else {
        this.parseMultipleFiles(info, destDir);
    }
    this.pieceCount = Math.floor((this.totalLength + this.pieceLength - 1) / this.pieceLength);
    this.lastPieceLength = this.pieceCount <= 0 ? 0 : this.totalLength - this.pieceLength * (this.pieceCount - 1);
}

/*
 * Filestore: { pieceLength, pieces, files: [{path offset length md5}...],
 *     left }
 * offset is in increasing order, so that binary search can find a given absolute offset.
 */
Store.prototype = {
    parseMultipleFiles: function(info, destDir) {
        var files = [];
        var totalLength = 0;
        for (i in info.files) {
            var file = infoFiles[i];
            files.push({
                path: path.join(destDir, info.name, file.path),
                offset: totalLength,
                length: file.length,
                md5sum: file.md5sum
            });
            totalLength += file.length;
        }
        this.files = files;
        this.totalLength = totalLength;
        console.debug('files: ' + JSON.stringify(this.files));
    },

    // begin and length are optional arguments.
    createPieceFragmentIterator: function(pieceIndex, begin, length){
        var pieceLength = this.pieceLength;
        var offset = pieceLength * pieceIndex + begin;
        var length = Math.min(this.totalLength - offset, length);
        return createRangeIterator(this.files, offset, length);
    },

    // Callback called repeatedly with args (error, data)
    // data will be null after all fragments have been read.

    readPiecePart: function(pieceIndex, begin, length, callback){
        var iterator = this.createPieceFragmentIterator(pieceIndex, begin, length);
        function readPieceImp() {
            var fragment;
            if (iterator.hasNext()) {
                fragment = iterator.next();
                ensureFile(fragment.file, function(error, file){
                    if (error) {
                        callback(error);
                    }
                    else {
                        fs.read(file.fd, fragment.length, fragment.offset, 'binary', function(err, data){
                            var fragment;
                            callback(err, data);
                            if (!err) {
                                timer.setTimeout(readPieceImp, 0);
                            }
                        });
                    }
                });
            }
            else {
                callback(null, null);
            }
        }
        readPieceImp();
    },

    readPiece: function(pieceIndex, callback){
        this.readPiecePart(pieceIndex, 0, this.pieceLength, callback);
    },

    //Callback (error)
    writePiecePart: function(pieceIndex, begin, data, callback){
        var iterator = this.createPieceFragmentIterator(pieceIndex, begin, data.length);
        function writePieceImp(){
            var fragment;
            if (iterator.hasNext()) {
                fragment = iterator.next();
                ensureFile(fragment.file, function(error, file){
                    var dataFrag;
                    if (error) {
                        callback(error);
                    }
                    else {
                        dataFrag = data.substring(0, fragment.length);
                        data = data.substring(fragment.length);
                        fs.write(file.fd, dataFrag, fragment.offset, 'binary', function(err, bytesWritten){
                            var fragment;
                            if (err) {
                                callback(err);
                            }
                            else {
                                writePieceImp();
                            }
                        });
                    }
                });
            }
            else {
                callback(null);
            }
        }
        writePieceImp();
    },

    pieceLength: function(pieceIndex){
        if (pieceIndex < this.pieceCount - 1) {
            return this.pieceLength;
        }
        else {
            return this.lastPieceLength;
        }
    },

    inspectPiece: function(pieceIndex, callback){
        var hash = new cryptolib.Hash('sha1');
        this.readPiece(pieceIndex, (function(error, data){
            if (error) {
                return callback(error);
            }
           
            if (data) {
                hash.update(data);
            } else {
                var digest = hash.digest('binary');
                var expected = this.pieces.substring(pieceIndex * 20, (pieceIndex + 1) * 20);
                console.debug('piece '+pieceIndex+' digest: '+hashToHexString(digest)+" expected: "+hashToHexString(expected));
                var goodPiece = expected === digest;
                
                callback(goodPiece ? null : new Error('piece '+pieceIndex+' hash mismatch'));
            }
        }).bind(this));
    },

    // callback(err)
    inspect: function(callback){
        this.goodPieces = bitfield.create(this.pieceCount);
        this.left = 0;
        function inspectCallback(pieceIndex, err){
            var goodPiece = (err == null);
            this.goodPieces.set(pieceIndex, goodPiece);
            if (!goodPiece) {
                this.left += this.pieceLength(pieceIndex);
            }
            if (pieceIndex + 1 < this.pieceCount) {
                timer.setTimeout(this.inspectPiece.bind(this, pieceIndex+1, inspectCallback.bind(this, pieceIndex+1)), 0);
            } else {
                callback(null);
            }
        }
        this.inspectPiece(0, inspectCallback.bind(this, 0));
    }
};

// Makes sure all the directories exist for a given path.
// If they don't exist, tries to create them.
// Calls callback(err)
function ensureDirExists(fullPath, callback){
    var mode = 7 * 64 + 7 * 8 + 7; // 0777 aka rwxrwxrwx-
    var parts = fullPath.split('/'), root;
    if (parts.length > 1) {
        parts.pop();
        if (fullPath.charAt(0) == '/') {
            root = '';
        }
        else {
            root = '.';
        }
        ensureDirExists2(root, parts, callback);
    }
    else {
        callback(null);
    }
    function ensureDirExists2(base, dirList, callback){
        var newPath = base + '/' + dirList.shift();
        fs.stat(newPath, function(err, stats){
            if (err) {
                makeDir();
            }
            else 
                if (!stats.isDirectory()) {
                    fs.unlink(newPath, function(err){
                        if (err) {
                            callback(err);
                        }
                        else {
                            makeDir();
                        }
                    });
                }
                else {
                    checkKids();
                }
        });
        function makeDir(){
            fs.mkdir(newPath, mode, checkKids);
        }
        function checkKids(err){
            if (err || dirList.length == 0) {
                callback(err);
            }
            else {
                ensureDirExists2(newPath, dirList, callback);
            }
        }
    }
}

function ensureFile2(file, callback){
    var mode = 6 * 64 + 4 * 8 + 4; // 0666 aka rw-rw-rw-
    fs.stat(file.path, function(err, stats){
        if (err) {
            fs.open(file.path, 'w', mode, function(error, fd){
                if (error) {
                    callback(error, file);
                }
                else {
                    fs.truncate(fd, file.length, function(error){
                        if (error) {
                            callback(error, file);
                        }
                        else {
                            // Need to close this descriptor and try again.
                            fs.close(fd, function(error){
                                if (error) {
                                    callback(error, file);
                                }
                                ensureFile2(file, callback);
                            });
                        }
                    });
                }
            });
        }
        else 
            if (stats.isDirectory() || stats.size !== file.length) {
                fs.unlink(file.path, function(error){
                    if (error) {
                        callback(error, file);
                    }
                    else {
                        ensureFile2(file, callback);
                    }
                });
            }
            else {
                // file exists, and is right length and type
                fs.open(file.path, 'r+', mode, function(error, fd){
                    if (error) {
                        callback(error, file);
                    }
                    else {
                        file.fd = fd;
                        callback(error, file);
                    }
                });
            }
    });
}

//Calls callback(err, file)
function ensureFile(file, callback){
    if (file.fd) {
        callback(null, file);
    }
    else {
        ensureDirExists(file.path, function(err){
            if (err) {
                callback(err, file);
            }
            else {
                ensureFile2(file, callback);
            }
        });
    }
}

exports.Store = Store;
