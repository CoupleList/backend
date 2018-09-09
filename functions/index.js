var functions = require('firebase-functions');
var admin = require('firebase-admin');
const mkdirp = require('mkdirp-promise');
const gcs = require('@google-cloud/storage')();
const spawn = require('child-process-promise').spawn;
const path = require('path');
const os = require('os');
const fs = require('fs');
const cors = require('cors')({origin: true});

admin.initializeApp(functions.config().firebase);

sendNotification = (tokens, payload) => {
  return new Promise((response, reject) => {
    admin.messaging().sendToDevice(tokens, payload).then((res) => {
      response(res);
    }).catch((err) => {
      reject(err);
    });
  });
};

writeHistory = (list, before, after, state) => {
  let key = admin.database().ref(`/lists/${list}/history/`).push().key;
  admin.database().ref(`/lists/${list}/history/${key}`).set({
    after: after,
    before: before,
    state: state,
    time: new Date().getTime()
  });
};

scaleProfileImage = (object) => {
  const bucket = gcs.bucket(object.bucket);
  const tempFilePath = path.join(os.tmpdir(), object.name);
  const rotationValue = Number(object.name.substring(object.name.lastIndexOf('_') + 1, object.name.indexOf('.')));
  const metadata = {
    contentType: object.contentType,
  };

  console.log('Creating temporary directory...');

  return mkdirp(path.dirname(tempFilePath)).then(() => {
    console.log('Temporary directory created.');

    console.log('Downloading profile image...');
    return bucket.file(object.name).download({
      destination: tempFilePath,
    }).then(() => {
      console.log('Profile image downloaded.', tempFilePath);
      console.log('Resizing profile image...');

      return spawn('convert', [tempFilePath, '-thumbnail', '300x300>', tempFilePath]);
    }).then(() => {
      console.log('Profile image resized.', tempFilePath);
      console.log('Rotating image...');

      const angle = rotationValue === 2 ? '180' : rotationValue === 3 ? '90' : rotationValue === 4 ? '-90' : '0';

      return spawn('convert', [tempFilePath, '-rotate', angle, tempFilePath]);
    }).then(() => {
      console.log('Profile image rotated.', tempFilePath);
      const resizedFilePath = object.name.replace(`_original_${rotationValue}`, '');

      return bucket.upload(tempFilePath, {
        destination: resizedFilePath,
        metadata: metadata,
      }).then(() => {
        console.log('Deleting original profile image...');

        return bucket.file(object.name).delete().then(() => {
          console.log('Original profile image deleted.');

          return true;
        });
      });
    }).then(() => fs.unlinkSync(tempFilePath));
  });
};

verifyUserHasPrivileges = (uid, type = null) => {
  return new Promise((resolve, reject) => {
    switch (type) {
      case 'analytics':
        admin.database().ref(`privileges/analytics/${uid}`).once('value', snapshot => {
          if (snapshot.exists() && snapshot.val() === true) {
            resolve();
          } else {
            reject();
          }
        });
        break;
      default:
        reject();
        break;
    }
  });
};

fetchLists = () => {
  return new Promise((resolve, reject) => {
    admin.database().ref(`/lists`).once('value', snapshot => {
      let lists = [];

      snapshot.forEach(childSnapshot => {
        let activities = 0;
        let completedActivities = 0;

        if (childSnapshot.child('activities').exists()) {
          childSnapshot.child('activities').forEach(activity => {
            activities++;
            if (activity.child('done').val()) {
              completedActivities++;
            }
          });
        }

        lists.push({
          id: childSnapshot.key,
          registeredUsers: childSnapshot.child('tokens').exists() ? childSnapshot.child('tokens').numChildren() : 0,
          activities,
          completedActivities
        });
      });

      resolve({
        count: snapshot.numChildren(),
        lists
      });
    });
  });
};

exports.handleActivityEvent = functions.database.ref('lists/{list}/activities/{activity}').onWrite((change, context) => {
  let list = context.params.list;
  let tokens = [];

  return admin.database().ref(`/lists/${list}/tokens`).once('value', (snapshot) => {
    snapshot.forEach(function (token) {
      tokens.push(token.val());
    });

    if (!change.before.exists()) {
      let activity = change.after.val();
      const payload = {
        notification: {
          title: 'An activity was added!',
          body: `Check out "${activity.title}" in your list!`,
          content_available: 'true'
        }
      };

      writeHistory(list, change.before.val(), change.after.val(), 1);

      sendNotification(tokens, payload).then((response) => {
        console.log('Message sent:', response);
        return true;
      }).catch((err) => {
        console.error('Errror sending message:', err);
        return false;
      });
    } else if (!change.after.exists()) {
      writeHistory(list, change.before.val(), change.after.val(), -1);
      return true;
    } else {
      if (change.after.val().done) {
        let activity = change.after.val();
        const payload = {
          notification: {
            title: 'An activity was completed!',
            body: `Check out "${activity.title}" in your list!`,
            content_available: 'true'
          }
        };

        writeHistory(list, change.before.val(), change.after.val(), 3);

        sendNotification(tokens, payload).then((response) => {
          console.log('Message sent:', response);
          return true;
        }).catch((err) => {
          console.error('Errror sending message:', err);
          return false;
        });
      } else {
        let activity = change.before.val();
        const payload = {
          notification: {
            title: 'An activity was edited!',
            body: `Check out "${activity.title}" in your list!`,
            content_available: 'true'
          }
        };

        writeHistory(list, change.before.val(), change.after.val(), 2);

        sendNotification(tokens, payload).then((response) => {
          console.log('Message sent:', response);
          return true;
        }).catch((err) => {
          console.error('Errror sending message:', err);
          return false;
        });
      }
    }
  });
});

exports.handleFeedbackEvent = functions.database.ref('feedback/{user}/{feedback}').onCreate((snapshot, context) => {
  return admin.auth().getUser(context.params.user).then((user) => {
    return admin.database().ref('feedback/token').once('value', (snapshot) => {
      let token = [snapshot.val()];
      let payload = {
        notification: {
          title: 'New feedback submitted',
          body: `${user.email} submitted new feedback, check ${context.params.user}/${context.params.feedback}.`,
          content_available: 'false'
        }
      };

      return sendNotification(token, payload).then((response) => {
        console.log('Message sent:', response);
        return true;
      }).catch((err) => {
        console.error('Errror sending message:', err);
        return false;
      });
    });
  }).catch((err) => {
    console.error('Error finding user who submitted feedback:', err);
    return false;
  });
});

exports.handleImageUploadEvent = functions.storage.object().onFinalize((object) => {
  if (object.name.startsWith('profileImages/')
    && object.name.includes('_original')
    && object.name.endsWith('.JPG')
    && object.contentType.startsWith('image/')) {
    return scaleProfileImage(object);
  }

  return false;
});

exports.lists = functions.https.onRequest((req, res) => {
  cors(req, res, () => {
    const bearer = req.headers.authorization.split(' ')[1];
    admin.auth().verifyIdToken(bearer)
      .then(decodedToken => {
        verifyUserHasPrivileges(decodedToken.uid, 'analytics')
          .then(() => {
            fetchLists()
              .then(data => res.status(200).send(data))
              .catch(err => res.status(500).send(err));
          })
          .catch(() => res.status(401).send('Account does not have privileges to access this data.'));
      }).catch((err) => {
        console.error(err);
        res.status(401).send('Unable to access this data.');
    });
  });
});
