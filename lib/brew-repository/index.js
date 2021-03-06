var Q = require('q'),
    schedule = require('node-schedule'),
    moment = require('moment'),
    _ = require('underscore'),
    mailer = require('../mailer'),
    monk = require('monk');

module.exports = BrewRepository;

function BrewRepository() {
    if (!(this instanceof BrewRepository)) {
        return new BrewRepository();
    }

    this.db = monk(process.env.MONGO_URL);
}

BrewRepository.prototype.get = function(id) {
    var deferred = Q.defer();

    var collection = this.db.get('brews');

    collection.findById(id, function(e, brew) {
        if (e) {
            deferred.reject(e);
        } else {
            deferred.resolve(brew);
        }
    });

    return deferred.promise;
}

BrewRepository.prototype.getLastBrewForUserId = function(userId) {
    var deferred = Q.defer();

    var collection = this.db.get('brews');

    collection.find({brewers: { $elemMatch: { id: userId } } }, { limit: 1, sort: { when: -1 }}, function(e, docs) {
        if (e) {
            return deferred.reject(e);
        }
        deferred.resolve(docs && docs.length ? docs[0] : {})
    });

    return deferred.promise;
}

BrewRepository.prototype.getLocationByIp = function(ipAddress) {
    var deferred = Q.defer();

    var collection = this.db.get('locations');

    collection.find({ipAddresses: { $in: [ipAddress]}}, function(e, brews) {
       if (e) {
           deferred.reject(e);
       } else {
           deferred.resolve(brews && brews.length ? brews[0] : void 0);
       }
    });

    return deferred.promise;
}

BrewRepository.prototype.deleteBrewer = function(userId, location) {
    var deferred = Q.defer();

    var collection = this.db.get('brews');

    this.next(location)
        .then(function(nextBrew) {
            collection.updateById(nextBrew._id, { $pull: { brewers: { id: userId } } }, function(e, brews) {
                if (e) {

                    deferred.reject(e);
                } else {
                    deferred.resolve(brews);
                }
            });
        });

    return deferred.promise;

}

BrewRepository.prototype.next = function(location, createIfNotPresent, minutes) {
    var deferred = Q.defer();

    var collection = this.db.get('brews');

    collection.find({ when: { $gt: new Date() }, where: location }, { limit: 1, sort: { when: 1 } }, function(e, brews){
        if (e) {
            deferred.reject(e);
        } else {
            if (createIfNotPresent && !brews.length) {
                this.createNext(location, minutes)
                    .then(function(nextBrew) {
                        deferred.resolve(nextBrew);
                    })
                    .fail(function(error) {
                        deferred.reject(error);
                    });
            } else {
                deferred.resolve(brews && brews.length ? brews[0] : {})
            }
        }
    }.bind(this));

    return deferred.promise;
}

BrewRepository.prototype.all = function() {
    var deferred = Q.defer();

    var collection = this.db.get('brews');

    collection.find({},{}, function(e, brews){
        if (e) {
            deferred.reject(e);
        } else {
            deferred.resolve(brews);
        }
    });

    return deferred.promise;
}

BrewRepository.prototype.allFuture = function() {
    var deferred = Q.defer();

    var collection = this.db.get('brews');

    collection.find({ when: { $gt: new Date() } }, function(e, brews){
        if (e) {
            deferred.reject(e);
        } else {
            deferred.resolve(brews);
        }
    });

    return deferred.promise;
}

BrewRepository.prototype.addUserToNextBrew = function(userId, usersName, brewer, location) {
    var deferred = Q.defer();
    var self = this;

    this.next(location, true, brewer.minutes)
        .then(function(nextBrew) {
            this.deleteBrewer(userId, location)
                .then(function() {
                    var collection = this.db.get('brews');

                    collection.updateById(nextBrew._id, { $push: { brewers: { id: userId, name: usersName, brew: brewer.brew, sugars: brewer.sugars, milk: brewer.milk, comments: brewer.comments } }  }, function(e, brews) {
                        if (e) {
                            deferred.reject(e);
                        } else {
                            deferred.resolve(brews)
                        }
                    });
                }.bind(this))
        }.bind(this));

    return deferred.promise;
}

BrewRepository.prototype.save = function(brew) {
    var deferred = Q.defer();

    var collection = this.db.get('brews');

    collection.updateById(brew._id, brew, function(e, brews) {
        if (e) {
            deferred.reject(e);
        } else {
            deferred.resolve(brew)
        }
    });

    return deferred.promise;
};

BrewRepository.prototype.setRandomBrewer = function(brew) {
    var brewers = brew.brewers;

    var numberOfBrewers = brewers.length;

    brew.hasBrewer = numberOfBrewers > 0;

    if (numberOfBrewers == 0) {
        return brew;
    }

    var brewerIndex = Math.floor(Math.random() * numberOfBrewers)

    brewers[brewerIndex].isBrewing = true;

    brew.brewer = brewers[brewerIndex];

    return brew;
};

BrewRepository.prototype.getBrewersForLocationAndPeriod = function(location, timeInHours) {
    var deferred = Q.defer();

    var collection = this.db.get('brews');

    var fortyEightHoursAgo = moment().add(-timeInHours, 'hours').toDate();

    collection.find({ when: { $lt: new Date(),  $gt: fortyEightHoursAgo }, where: location }, function(e, docs) {
        if (e) {
            deferred.reject(e);
            return;
        }
        var result = { brewers: {} };
        _.each(docs, function(d) {
            _.each(d.brewers, function(b) {
                result.brewers[b.id.split('|')[1]] = b;
            });
        })
        deferred.resolve(result);
    });

    return deferred.promise;
};

BrewRepository.prototype.createNext = function(location, minutes) {
    var deferred = Q.defer();

    var collection = this.db.get('brews');

    var minutesToGo = minutes || process.env.BREW_TIME || 10;

    var nextWhen = moment().add(minutesToGo, process.env.BREW_UNIT || 'minutes');
    var self = this;

    collection.insert({ when: nextWhen.toDate(), where: location, brewers: [] }, function(err, doc) {
        if (err) {
            deferred.reject(err);
        } else {
            console.info('scheduling job for ' + doc.when);

            schedule.scheduleJob(doc.when, function() {
                this.get(doc._id)
                    .then(function(brew) {
                        var updatedBrew = this.setRandomBrewer(brew);
                        if (!updatedBrew.hasBrewer) {
                            return;
                        }

                        this.save(updatedBrew);

                        mailer().send(updatedBrew);
                    }.bind(this));
            }.bind(this));

            this.getBrewersForLocationAndPeriod(location, 48)
                .then(function(brewers) {
                    mailer().sendAlert(brewers, location, minutesToGo);
                });
            deferred.resolve(doc);
        }
    }.bind(this));

    return deferred.promise;
}