var OAuth = require('oauth').OAuth;
var express = require('express');
var fs = require('fs');
var path = require('path');
var _ = require('underscore');
var tumblr = require('tumblr.js');

var app = express();
var port = (process.env.PORT || 8080);
app.set('port', port);

var config = require('./config');
var bot = require('./bot');

//Just to open files for now
var sys = require('sys');
var exec = require('child_process').exec;

var getToken = false;

var consumer = new OAuth("https://www.tumblr.com/oauth/request_token",
                  "https://www.tumblr.com/oauth/access_token",
                  config.tumblr.consumer_key,
                  config.tumblr.consumer_secret,
                  "1.0A",
                  "http://localhost:"+port+"/auth",
                  "HMAC-SHA1");


var oauthRequestToken, oauthRequestTokenSecret;

var login = function(req, res){
  consumer.getOAuthRequestToken(function(err, oauthToken, oauthTokenSecret){
    if(err){
      res.send("Error getting OAuth request token");
    } else {
      oauthRequestToken = oauthToken;
      oauthRequestTokenSecret = oauthTokenSecret;
      res.redirect("http://www.tumblr.com/oauth/authorize?oauth_token=" + oauthRequestToken);
    }
  });
};


var onLogin = function(req, res){
  consumer.getOAuthAccessToken(
    oauthRequestToken,
    oauthRequestTokenSecret,
    req.query.oauth_verifier,
    function(error, _oauthAccessToken, _oauthAccessTokenSecret) {
      if (error) {
        res.send("Error getting OAuth access token: " + error, 500);
      } else {
        //you want to save these, preferably linked to your user's id
        console.log(_oauthAccessToken);
        console.log(_oauthAccessTokenSecret);
        res.send('You are signed in. welcome Check console of oauth token and secret');
      }
  });
};


if ( getToken ){

  app.get('/auth',onLogin);
  app.get('/', login);
  app.listen(app.get('port'), function() {
    console.log("Post To Be at localhost:" + app.get('port')+ '/' );
  });

}

var post = {};

var puts = function (error, stdout, stderr) { sys.puts(stdout) };

var onAppendFileToPosted = function(err, data){

  //wait config.interval and start

};

var onPostFileToTumblr = function(err, res){
  console.log('opening file');
  //for now just open file
  exec("open '" + post.filePath + "'", puts);

};

var onGetTags = function(err, data){
  if(err) {

  } else {
    console.log('tags are : ' + data);
    onPostFileToTumblr();
  }
};

var onCheckPosted = function(err, data){
  if(err){
    console.log(err);
    //restart
    init(config.collection);
  } else {
    console.log('checksum is : ' + data);
    bot.getTags(config.collection, post.filePath, onGetTags);
  }
};

var onCheckBlackList = function(err, data){
  if(err){
    console.log(err);
    //restart
    init(config.collection);
  } else {
    console.log('direcotry is : ' + data);
    bot.checkPosted( post.filePath, onCheckPosted );
  }
};

var onCheckFileType = function(err, data){
  if(err){
    console.log(err);
    // restart
    init(config.collection);
  } else {
    bot.checkBlackList( config.collection, post.filePath, onCheckBlackList );
  }

};

var onWalk = function(err, data){

  if(err){
    console.log(err);
  } else {
      //get random file
      post.filePath = bot.pickRandom(data);
      //check filetype
      console.log('post filePath is : ' + post.filePath  );
      bot.checkFileType(post.filePath, config.fileTypes, onCheckFileType);

  }

};

var init = function(collection){
  bot.walk(collection, onWalk);
};

init(config.collection);
