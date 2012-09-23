'use strict';

const bitfield = require('./bitfield');
const fs = require('./fs');
const cryptolib = require('./crypto');
const path = require('path');
const timers = require('timers');
const {Logged} = require('./log');
const {Class} = require('heritage');
const {btoa} = require('base64');
const {EventTarget} = require('event/target');
const {emit} = require('event/core');
const {destDir} = require('./settings');

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
        } else {
            if (file.offset < offset) {
                a = c;
            } else {
                b = c;
            }
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
                throw new Error("StopIteraton");
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

const File = Class({
    implements: [Logged, EventTarget],
    initialize: function(store, info, file, offset) {
        this.store = store;
        this.name = file.path;
        this.tag = this.name.slice(10);
        this.path = path.join(destDir, info.name, file.path);
        this.offset = offset;
        this.length = file.length;
        this.md5sum = file.md5sum;
        this.notifyOffset = this.offset;
        this.notifyInProgress = false;
        this.store.on('havepiece', (function(index) {
            let [begin, end] = this.getPiecesRange();
            if (begin <= index || index < end) {
                emit(this, 'havepiece', index);
                if (!this.notifyInProgress) {
                    this.notify();
                }
            }
        }).bind(this));
        this.debug('initialized. name: '+this.name+'; path: '+this.path+'; offset: '+this.offset+'; length: '+this.length+'; md5sum: '+this.md5sum);
    },

    notify: function() {
        this.notifyInProgress = true;
        if (this.notifyOffset < this.offset + this.length) {
            let index = this.getPieceForOffset(this.notifyOffset);
            let pieces = this.store.goodPieces.getBitArray();
            if (pieces[index] > 0) {
                this.store.readPiece(index, (function(error, data) {
                    if (!error) {
                        if (data !== null) {
                            let from = this.notifyOffset % this.store.pieceLength;
                            let to = Math.min(this.offset + this.length - this.notifyOffset, data.length);
                            let subdata = data.slice(from, to);
                            this.notifyOffset += subdata.length;
                            emit(this, 'data', subdata);
                            this.notify();
                        }
                    } else {
                        this.error('failed to notify about data: '+error);
                        this.notifyInProgress = false;
                    }
                }).bind(this));
            } else {
                this.notifyInProgress = false;
            }
        } else {
            emit(this, 'end');
            this.notifyInProgress = false;
        }
    },

    getPieceForOffset: function(offset) {
        return Math.floor(offset / this.store.pieceLength);
    },

    getPiecesRange: function() {
        let begin = this.getPieceForOffset(this.offset);
        let end = this.getPieceForOffset(this.offset + this.length);
        return [begin, end];
    },

    getNeededPieces: function() {
        let pieces = this.store.goodPieces.getBitArray();
        let [begin, end] = this.getPiecesRange();
        let needed = [];
        for (let i = begin; i < end; ++i) {
            this.debug('piece '+i+' is '+pieces[i]);
            if (pieces[i] === 0) {
                needed.push(i);
            }
        }
        return needed;
    }
});

/*
 * Filestore: { pieceLength, pieces, files: [{path offset length md5}...],
 *     left }
 * offset is in increasing order, so that binary search can find a given absolute offset.
 */
const Store = Class({
    implements: [Logged, EventTarget],
    name: 'Store',
    initialize: function(info) {
        this.goodPieces = bitfield.create(0);
        this.files = [];
        this.pieceLength = info['piece length'];
        this.pieces = info.pieces;
        this.tag = info.name;
        this.downloading = [];

        // Check if this is a single file torrent or a file list torrent
        if (info.length !== undefined) {
            // single file
            let file = new File(this, info, { 
                path: '',
                length: info.length,
                md5: info.md5
            }, 0);
            this.files = [file];
            this.totalLength = info.length;
        } else {
            this.parseMultipleFiles(info, destDir);
        }
        this.pieceCount = Math.floor((this.totalLength + this.pieceLength - 1) / this.pieceLength);
        this.lastPieceLength = this.pieceCount <= 0 ? 0 : this.totalLength - this.pieceLength * (this.pieceCount - 1);
        this.goodPieces = bitfield.create(this.pieceCount, this.goodPieces.getWire());
        this.debug('initialized. piece length '+this.pieceLength+'; piece count '+this.pieceCount);
    },

    parseMultipleFiles: function(info, destDir) {
        let totalLength = 0;
        for each (let fileInfo in info.files) {
            let file = new File(this, info, fileInfo, totalLength);
            this.files.push(file);
            totalLength += file.length;
        }
        this.totalLength = totalLength;
    },

    getFile: function(name) {
        for each (let file in this.files) {
            this.debug('comparing '+file.name+' against '+name);
            if (file.name == name) {
                return file;
            }
        }
        throw new Error('no file with path '+name);
    },

    get webInfo() {
        return {
            'total': this.pieceCount,
            'have': this.available.length,
            'needed': this.needed.length
        };
    },

    filterPieces: function(value) {
        return this.goodPieces.getBitArray().filter(function(val){ return val == value; });
    },

    get needed() {
        return this.filterPieces(0);
    },

    get available() {
        return this.filterPieces(1);
    },

    havePiece: function(index) {
        return this.goodPieces.getBitArray()[index] === 1;
    },

    // begin and length are optional arguments.
    createPieceFragmentIterator: function(pieceIndex, begin, length){
        let pieceLength = this.pieceLength;
        let offset = pieceLength * pieceIndex + begin;
        let length = Math.min(this.totalLength - offset, length);
        return createRangeIterator(this.files, offset, length);
    },

    // Callback called repeatedly with args (error, data)
    // data will be null after all fragments have been read.

    readPiecePart: function(pieceIndex, begin, length, callback){
        let iterator = this.createPieceFragmentIterator(pieceIndex, begin, length);
        function readPieceImp() {
            var fragment;
            if (iterator.hasNext()) {
                fragment = iterator.next();
                ensureFile(fragment.file, function(error, file){
                    if (error) {
                        callback(error);
                    } else {
                        fs.read(file.fd, fragment.length, fragment.offset, 'binary', function(err, data){
                            var fragment;
                            callback(err, data);
                            if (!err) {
                                timers.setTimeout(readPieceImp, 0);
                            }
                        });
                    }
                });
            } else {
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
        let iterator = this.createPieceFragmentIterator(pieceIndex, begin, data.length);
        function writePieceImp(){
            var fragment;
            if (iterator.hasNext()) {
                fragment = iterator.next();
                ensureFile(fragment.file, function(error, file){
                    var dataFrag;
                    if (error) {
                        callback(error);
                    } else {
                        dataFrag = data.substring(0, fragment.length);
                        data = data.substring(fragment.length);
                        fs.write(file.fd, dataFrag, fragment.offset, 'binary', function(err, bytesWritten){
                            var fragment;
                            if (err) {
                                callback(err);
                            } else {
                                writePieceImp();
                            }
                        });
                    }
                });
            } else {
                callback(null);
            }
        }
        writePieceImp();
    },

    getPieceLength: function(pieceIndex){
        if (pieceIndex < this.pieceCount - 1) {
            return this.pieceLength;
        } else {
            return this.lastPieceLength;
        }
    },

    inspectPiece: function(pieceIndex, callback){
        let hash = new cryptolib.Hash('sha1');
        this.readPiece(pieceIndex, (function(error, data) {
            if (error) {
                return callback(error);
            }
           
            if (data) {
                hash.update(data);
            } else {
                var digest = hash.digest('binary');
                var expected = this.pieces.substring(pieceIndex * 20, (pieceIndex + 1) * 20);
                this.debug('piece '+pieceIndex+' digest: '+hashToHexString(digest)+" expected: "+hashToHexString(expected));
                var goodPiece = expected === digest;
                
                callback(goodPiece ? null : new Error('piece '+pieceIndex+' hash mismatch'));
            }
        }).bind(this));
    },

    inspect: function(callback){
        this.trace('inspecting existent torrent data');
        this.goodPieces = bitfield.create(this.pieceCount);
        function inspectCallback(pieceIndex, err){
            var goodPiece = (err === null);
            this.goodPieces.set(pieceIndex, goodPiece);
            if (!goodPiece) {
                emit(this, 'needpiece', pieceIndex);
            } else {
                emit(this, 'havepiece', pieceIndex);
            }
            if (pieceIndex + 1 < this.pieceCount) {
                timers.setTimeout(this.inspectPiece.bind(this, pieceIndex+1, inspectCallback.bind(this, pieceIndex+1)), 0);
            } else {
                this.debug('finished inspecting torrent data');
            }
        }
        this.inspectPiece(0, inspectCallback.bind(this, 0));
    },
 
    onPieceFragment: function(index, offset, data) {
        let length = data.length;
        let pieceLength = (index === this.pieceCount - 1) ? this.lastPieceLength : this.pieceLength;
        if (!((offset >= 0 && offset + length <= pieceLength) &&
            (length > 0 && length <= 32 * 1024) &&
            (index >= 0 && index < this.pieceCount))) {
            this.error('could not add corrupted piece: index='+index+' offset='+offset+' length='+length);
            throw new Error('bad piece parameters');
        }
        this.debug("received piece " + index +' ' + offset + ' ' + length);
        
        if(!this.downloading[index])
            this.downloading[index] = {};
        this.downloading[index][offset] = true;

        /*if (this.pieces[index] === undefined) {
            this.pieces[index] = new Uint8Array(pieceLength);
        }

        let piece = this.pieces[index];
        piece.set(data, offset);

        return;*/

        this.writePiecePart(index, offset, data, (function(err) {
            if (err) {
                this.warn('piece '+index+' writing failed', err);
                return;
            }
            this.debug('wrote piece ' + index + ' fragment ['+offset+';'+(offset+data.length)+']'); // Reduced verbosity.
            
            var hasdone = 0;                
            for (let z in this.downloading[index])
                hasdone += +this.downloading[index][z];
            
            if (hasdone === Math.ceil(pieceLength/data.length)){
                delete this.downloading[index];
                
                this.inspectPiece(index, (function(error) {
                    if (!error) {
                        this.info('wrote piece ' + index);
                        this.goodPieces.set(index, 1); //change bitfield
                        emit(this, 'havepiece', index);
                    } else {
                        this.warn('waah broken piece: ', error);
                    }
                }).bind(this))
            } else {
                this.debug('not done yet')
            }
        }).bind(this));
    }
});

// Makes sure all the directories exist for a given path.
// If they don't exist, tries to create them.
// Calls callback(err)
function ensureDirExists(fullPath, callback) {
    var mode = 7 * 64 + 7 * 8 + 7; // 0777 aka rwxrwxrwx-
    var parts = fullPath.split('/'), root;
    if (parts.length > 1) {
        parts.pop();
        if (fullPath.charAt(0) == '/') {
            root = '';
        } else {
            root = '.';
        }
        ensureDirExists2(root, parts, callback);
    } else {
        callback(null);
    }
    function ensureDirExists2(base, dirList, callback){
        var newPath = base + '/' + dirList.shift();
        fs.stat(newPath, function(err, stats){
            if (err) {
                makeDir();
            } else if (!stats.isDirectory()) {
                fs.unlink(newPath, function(err){
                    if (err) {
                        callback(err);
                    } else {
                        makeDir();
                    }
                });
            } else {
                checkKids();
            }
        });
        function makeDir(){
            fs.mkdir(newPath, mode, checkKids);
        }
        function checkKids(err){
            if (err || dirList.length == 0) {
                callback(err);
            } else {
                ensureDirExists2(newPath, dirList, callback);
            }
        }
    }
}

function ensureFile2(file, callback) {
    var mode = 6 * 64 + 4 * 8 + 4; // 0666 aka rw-rw-rw-
    fs.stat(file.path, function(err, stats) {
        if (err) {
            fs.open(file.path, 'w', mode, function(error, fd){
                if (error) {
                    callback(error, file);
                } else {
                    fs.truncate(fd, file.length, function(error){
                        if (error) {
                            callback(error, file);
                        } else {
                            // Need to close this descriptor and try again.
                            fs.close(fd, function(error){
                                if (error) {
                                    callback(error, file);
                                } else {
                                    ensureFile2(file, callback);
                                }
                            });
                        }
                    });
                }
            });
        } else if (stats.isDirectory() || stats.size !== file.length) {
            fs.unlink(file.path, function(error){
                if (error) {
                    callback(error, file);
                } else {
                    ensureFile2(file, callback);
                }
            });
        } else {
            // file exists, and is right length and type
            fs.open(file.path, 'r+', mode, function(error, fd){
                if (error) {
                    callback(error, file);
                } else {
                    file.fd = fd;
                    callback(error, file);
                }
            });
        }
    });
}

//Calls callback(err, file)
function ensureFile(file, callback) {
    if (file.fd) {
        callback(null, file);
    } else {
        ensureDirExists(file.path, function(err) {
            if (err) {
                callback(err, file);
            } else {
                ensureFile2(file, callback);
            }
        });
    }
}

exports.Store = Store;
