var http = require("https");
var fs = require("fs");
var crypto = require('crypto');
var sqlite3 = require('sqlite3').verbose();
var tokens = require('js-cache');

var db = new sqlite3.Database('database.db');
var tenMinutes = 1000 * 60 * 10;

const options = {
    key: fs.readFileSync('privkey.pem'),
    cert: fs.readFileSync('cert.pem')
};

//We will send them a 404 response if page doesn't exist
function send404Response(response) {
    console.log("Invalid request - 404 response to client");
    response.writeHead(404, {"Content-Type": "text/plain"});
    response.write("Error 404 - Page not found");
    response.end();
}

//Handle their request
function onRequest(request, response) {
    var body = '';
    var sqlResult = [];

    if (request.method == 'POST') {
        request.on('data', function (data) {
            body += data;

            // Too much POST data, kill the connection!
            // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
            if (body.length > 1e6)
                request.connection.destroy();
        });

        request.on('end', function () {
                var password;
                var post;
                if (body) {
                    try {
                        post = JSON.parse(body);
                    } catch (e) {
                        console.log('PARSE ERROR');
                        send404Response(response);
                        return;
                    }
                } else {
                    send404Response(response);
                    return;
                }
                var address = request.connection.remoteAddress.replace(/^.*:/, '');

                if (!queryErrorHandling(post)) {
                    send404Response(response);
                    return;
                }
                var today = new Date();
                today.setHours(today.getHours() +1);
                console.log(today.toISOString().substring(0,19) + ' Request from: ' + address + ' - ' + post.query);

                /*--------------------------LOGIN QUERY-----------------------------*/

                if (post.query === 'login') {
                    db.each('select * from users where username=?', post.username.toLowerCase(), function (err, row) {
                        password = row.Password;
                    }, function (err, row) {
                        var sendObj;
                        if (row === 0) {
                            sendObj = {
                                "response": post.username + ' does not exist',
                                'username': ''
                            };
                            responseToClient(response, sendObj)
                        } else {
                            if (getSHA1(post.password) === password) {
                                crypto.randomBytes(8, function (err, token) {
                                    token = token.toString('hex');
                                    console.log(token);
                                    tokens.set(post.username.toLocaleLowerCase(), token, tenMinutes);
                                    db.each('select GameID, Black as Opp, Turn, White, Black, Pos from games where white=? union select GameID, white as Opp, Turn, White, Black Pos from games where black=?', post.username.toLowerCase(), post.username.toLowerCase(), function (err, row) {
                                        sqlResult.push(row);
                                    }, function () {
                                        var sendObj = {
                                            "sql": sqlResult,
                                            'username': post.username,
                                            'response': 'Login successful',
                                            'token': token
                                        };
                                        responseToClient(response, sendObj);
                                    });
                                });
                            } else {
                                sendObj = {
                                    'username': '',
                                    'response': 'L'
                                };
                                responseToClient(response, sendObj)
                            }
                        }
                    });


                    /*--------------------------NEW GAME QUERY-----------------------------*/
                } else if (post.query === 'newGame') {
                    if (post.token == tokens.get(post.username.toLocaleLowerCase())) {
                        tokens.set(post.username.toLocaleLowerCase(), post.token, tenMinutes);

                        if (post.opponent.toLowerCase() == post.username.toLowerCase()) {
                            sendObj = {
                                "response": 'Error: Can\'t play with yourself',
                                'username': ''
                            };
                            responseToClient(response, sendObj)
                        } else {
                            db.each('select * from users where username=?', post.opponent.toLowerCase(), function () {
                            }, function (err, row) {
                                var sendObj;
                                if (row === 0) {
                                    sendObj = {
                                        "sql": sqlResult,
                                        "response": 'User does not exist',
                                        'username': ''
                                    };
                                    responseToClient(response, sendObj)

                                } else {
                                    db.each('select count(*) as count from (select GameID, Black as Opp, Turn, Pos from games where white=? union select GameID, white as Opp, Turn, Pos from games where black=?)', post.opponent.toLowerCase(), post.opponent.toLowerCase(), function (err, row) {
                                        if (row.count < 10) {
                                            stmt = db.prepare('INSERT INTO games (GameID, White, Black, Turn, Pos) VALUES(NULL,?,?,?,?)');
                                            stmt.run(post.opponent.toLowerCase(), post.username.toLowerCase(), post.opponent.toLowerCase(), 'iiiiiiiii', function (err) {
                                                db.each('select GameID, White as Opp, Pos, Turn, White, Black from games where GameID = ? ', this.lastID, function (err, row) {
                                                    sqlResult.push(row);
                                                }, function () {
                                                    var sendObj = {
                                                        "sql": sqlResult,
                                                        "response": "NewGame"
                                                    };
                                                    responseToClient(response, sendObj)

                                                });
                                            });
                                            stmt.finalize();
                                        } else {
                                            sendObj = {
                                                "sql": sqlResult,
                                                "response": post.opponent.toLowerCase() + ' has maximum number of games'
                                            };
                                            responseToClient(response, sendObj)

                                        }
                                    });
                                }

                            });
                        }
                    } else {
                        console.warn('FEL TOKEN');
                        var sendObj = {
                            "response": 'Error wrong token'
                        };
                        responseToClient(response, sendObj)
                    }

                }

                /*--------------------------NEW RANDOM GAME QUERY-----------------------------*/
                else if (post.query === 'newGameRandom') {
                    if (post.token == tokens.get(post.username.toLocaleLowerCase())) {
                        tokens.set(post.username.toLocaleLowerCase(), post.token, tenMinutes);
                        var bool = false;
                        var randomUser;
                        db.each("select Username from (select Username from users where not Username = ?) order by random() limit 1", post.username.toLowerCase(), function (err, row) {
                            randomUser = row.Username;
                            db.each('select count(*) as count from (select GameID, Black as Opp, Turn, Pos from games where white=? union select GameID, white as Opp, Turn, Pos from games where black=?)', randomUser, randomUser, function (err, row) {
                                if (row.count < 10) {
                                    bool = true;
                                    var stmt = db.prepare('INSERT INTO games (GameID, White, Black, Turn, Pos) VALUES(NULL,?,?,?,?)');
                                    stmt.run(randomUser, post.username.toLowerCase(), randomUser, 'iiiiiiiii', function (err) {
                                        db.each('select GameID, White as Opp, Pos, Turn, White, Black from games where GameID = ? ', this.lastID, function (err, row) {
                                            sqlResult.push(row);
                                        }, function () {
                                            var sendObj = {
                                                "sql": sqlResult,
                                                "response": "NewRandomGame"
                                            };
                                            responseToClient(response, sendObj)
                                        });
                                    });
                                    stmt.finalize();
                                } else {
                                    sendObj = {
                                        "sql": sqlResult,
                                        "response": 'NewRandomGame'
                                    };
                                    responseToClient(response, sendObj)
                                }
                            });

                        });
                    } else {
                        console.warn('FEL TOKEN');
                        console.log('Sended token: ' + post.token);
                        console.log('Token saved : ' + tokens.get(post.username.toLocaleLowerCase()));

                        sendObj = {
                            "response": 'Error wrong token'
                        };
                        responseToClient(response, sendObj)
                    }


                    /*--------------------------REGISTER QUERY-----------------------------*/
                } else if (post.query === 'register') {
                    crypto.randomBytes(8, function (err, token) {
                        token = token.toString('hex');
                        console.log(token);
                        db.each('select * from users where username=?', post.username.toLowerCase(), function () {
                        }, function (err, row) {
                            var sendObj;
                            if (row === 0) {

                                var stmt = db.prepare('INSERT INTO users (Username, Password) VALUES(?,?)');
                                stmt.run(post.username.toLowerCase(), getSHA1(post.password));
                                sendObj = {
                                    "response": post.username + ' registered',
                                    "token": token
                                };
                                tokens.set(post.username.toLocaleLowerCase(), token, tenMinutes);

                            } else {
                                sendObj = {
                                    "response": 'User already exists'
                                };
                            }
                            responseToClient(response, sendObj)
                        });
                    });

                    /*--------------------------UPDATE GAME QUERY-----------------------------*/
                } else if (post.query === 'updateGame') {
                    if (post.token == tokens.get(post.username.toLocaleLowerCase())) {
                        tokens.set(post.username.toLocaleLowerCase(), post.token, tenMinutes);

                        var stmt = db.prepare('UPDATE games SET Turn = ?, Pos = ? WHERE GameID = ?');
                        stmt.run(post.Turn, post.Pos, post.GameID);
                        stmt.finalize();
                        db.each('select Turn, Pos from games where GameID=?', post.GameID, function (err, row) {
                            sqlResult.push(row);
                        }, function () {
                            sendObj = {
                                "sql": sqlResult,
                                'response': 'MoveMade'
                            };
                            responseToClient(response, sendObj);

                        });
                    } else {
                        console.warn('FEL TOKEN');
                        console.log('Sended token: ' + post.token);
                        console.log('Token saved : ' + tokens.get(post.username.toLocaleLowerCase()));

                        sendObj = {
                            "response": 'Error wrong token'
                        };
                        responseToClient(response, sendObj)

                    }


                    /*--------------------------GET GAME STATE QUERY-----------------------------*/
                } else if (post.query == 'getGamesState') {
                    if (post.token == tokens.get(post.username.toLocaleLowerCase())) {
                        tokens.set(post.username.toLocaleLowerCase(), post.token, tenMinutes);
                        db.each('select GameID, Black as Opp, Turn,white,black, Pos from games where white=? union select GameID, white as Opp, Turn,white,black, Pos from games where black=?', post.username.toLowerCase(), post.username.toLowerCase(), function (err, row) {
                            sqlResult.push(row);
                        }, function () {
                            var sendObj = {
                                "sql": sqlResult,
                                'username': post.username,
                                'response': 'GamesSent'
                            };
                            responseToClient(response, sendObj)
                        });
                    } else {
                        console.warn('FEL TOKEN');
                        console.log('Sended token: ' + post.token);
                        console.log('Token saved : ' + tokens.get(post.username.toLocaleLowerCase()));
                        sendObj = {
                            "response": 'Error wrong token'
                        };
                        responseToClient(response, sendObj)
                    }
                    /*--------------------------GET SINGLE GAME STATE QUERY-----------------------------*/
                } else if (post.query == 'getSingleGameState') {
                    if (post.token == tokens.get(post.username.toLocaleLowerCase())) {
                        tokens.set(post.username.toLocaleLowerCase(), post.token, tenMinutes);
                        db.each('select Turn, Pos from games where GameID = ?', post.GameID, function (err, row) {
                            sqlResult.push(row)
                        }, function () {
                            var sendObj = {
                                'sql': sqlResult,
                                'response': 'Current state'
                            };
                            console.log(sendObj);
                            response.writeHead(200, {"Content-Type": "application/json"});
                            response.write(JSON.stringify(sendObj));
                            response.end();
                        });
                    } else {
                        console.warn('FEL TOKEN');
                        console.log('Sended token: ' + post.token);
                        console.log('Token saved : ' + tokens.get(post.username.toLocaleLowerCase()));
                        sendObj = {
                            "response": 'Error wrong token'
                        };
                        responseToClient(response, sendObj)
                    }
                    /*--------------------------GAME OVER QUERY-----------------------------*/
                } else if (post.query == 'gameOver') {
                    if (post.token == tokens.get(post.username.toLocaleLowerCase())) {
                        tokens.set(post.username.toLocaleLowerCase(), post.token, tenMinutes);
                        stmt = db.prepare('DELETE FROM GAMES WHERE GameID=?');
                        stmt.run(post.GameID);
                        stmt.finalize();
                        sendObj = {
                            'sql': sqlResult,
                            'response': 'Game Over/Deleted'
                        };
                    } else {
                        console.warn('FEL TOKEN');
                        console.log('Sended token: ' + post.token);
                        console.log('Token saved : ' + tokens.get(post.username.toLocaleLowerCase()));
                        sendObj = {
                            "response": 'Error wrong token'
                        };
                    }
                    responseToClient(response, sendObj);
                }
            }
        );
    }

    else {
        send404Response(response);
    }
}

function getSHA1(input) {
    var generator = crypto.createHash('sha1');
    generator.update(input);
    return generator.digest('hex');
}

function responseToClient(response, sendObj) {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.write(JSON.stringify(sendObj));
    response.end();
}

function queryErrorHandling(post) {
    if (!post.hasOwnProperty('query')) {
        console.log('query finns inte');
        return false;
    }
    if (post.query === 'login') {
        if (post.username && post.password)
            return true;
    } else if (post.query === 'newGame') {
        if (post.username && post.token && post.opponent)
            return true;
    } else if (post.query === 'newGameRandom') {
        if (post.username && post.token)
            return true;
    } else if (post.query === 'register') {
        console.log('REGHORA');
        if (post.username && post.password)
            return true;
    } else if (post.query === 'updateGame') {
        if (post.username && post.token && post.Turn && post.Pos && post.GameID)
            return true;
    } else if (post.query == 'getGamesState') {
        if (post.username && post.token)
            return true;
    } else if (post.query == 'getSingleGameState') {
        if (post.username && post.token && post.GameID)
            return true;
    } else if (post.query == 'gameOver') {
        if (post.username && post.token && post.GameID)
            return true;
    }
}

http.createServer(options, onRequest).listen(1024);
console.log("Server is now running...");