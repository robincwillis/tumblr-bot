var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var mime = require('mime');
var _ = require('underscore');

var dir = {

	appendFileToPosted : function(checksum, callback){

	},

	postFileToTumblr : function(post, url, oauth, callback){

	},

	getFileType : function(filePath){
		return mime.lookup(filePath);
	},

	//pull filename from filepath
	getFileName : function(filePath){
		return path.basename(filePath);
	},

	//pull dir from filepath
	getDirectoryName : function(filePath){
		return path.dirname(filePath);
	},

	//md5 checksum for file
	getChecksum : function(filePath, callback){

		fs.readFile(filePath, function(err, data){
			var checkSum =crypto.createHash('md5').update(data, 'utf8').digest('hex');
			callback(err, checkSum);
		});

	},

	walk : function(directory, callback) {
		var results = [];
		fs.readdir(directory, function(err, list) {
			if (err) return callback(err);
			var pending = list.length;
			if (!pending) return callback(null, results);
			list.forEach(function(file) {
				file = path.resolve(directory, file);
				fs.stat(file, function(err, stat) {
					if (stat && stat.isDirectory()) {
						dir.walk(file, function(err, res) {
							results = results.concat(res);
							if (!--pending) callback(null, results);
						});
					} else {
						results.push(file);
						if (!--pending) callback(null, results);
					}
				});
			});
		});
	},

	pickRandom : function(dirs){
		var index = Math.floor((Math.random() * dirs.length) +1);
		return dirs[index];
	},

	getList : function(file, callback){
		fs.readFile(file, 'utf8', function (err, data) {
			if (err) {
				console.log('Error: ' + err);
			}
			data = JSON.parse(data);
			callback(err, data);

		});
	},

	getTags : function(rootPath, filePath, callback){
		var directory = dir.getDirectoryName(filePath);
		var tags = directory
			.substring(rootPath.length)
			.toLowerCase()
			.split('/');
			tags.shift();
		//todo check if tags is array;
		callback(null, tags);
	},

	checkPosted : function(filePath, callback){

		dir.getChecksum(filePath, function(err, checksum){

			if(err){
				console.log("Error getting checksum");
			}

			dir.getList('posted.json', function(err, posted){

				console.log('Posted is : ' + posted);

				if(err) {
					callback(err, checksum);
				} else {
					if( _.contains(posted, checksum) ){
						var error = "File has already been Posted : "  + checksum;
						callback(error, checksum);
					} else {
						callback(null, checksum);
					}
				}
			});
		});
	},

	checkBlackList : function(rootPath, filePath, callback){

		var directory = dir.getDirectoryName(filePath).substring(rootPath.length);

		dir.getList('blacklist.json', function(err, blacklist){

			if (err) {
				console.log("Error : " + err);
				callbacK(err, directory);

			} else {

				if( _.contains(blacklist, directory) ){
					var error = "Directory " + directory + " is blacklisted";
					callback(error, directory);
				} else {
					callback(null, directory);
				}

			}
		});
	},

	checkFileType : function(filePath, fileTypes, callback){
		var fileType = this.getFileType(filePath);
		if( _.contains(fileTypes, fileType) ){
			callback(null, fileType);
		} else {
			var error = "File type "+ fileType +" is invalid";
			callback(error, fileType);
		}

	},


};

module.exports = dir;