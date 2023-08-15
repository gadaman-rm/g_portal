const http = require("http");
const WebSocketServer = require("websocket").server;
const EventEmitter = require("events");
const url = require("url");
const jwt = require("jsonwebtoken");
const _ = require('lodash');
const Utility = require('./Utility');

class GPortalServer extends EventEmitter {
  G_options;
  G_iotDevices;
  G_controlDevices;
  G_portal_msgs = {
    connectionAccepted: {
      G_id: "G_PORTAL",
      G_msg_type: "report",
      G_msg: "connectionAccepted",
    },
    msgReceived: {
      G_id: "G_PORTAL",
      G_msg_type: "report",
      G_msg: "msgReceived",
    },
  };
  constructor(options) {
    super();
    this.G_options = options;
    this.httpServer = http.createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.httpServer.listen(options.port, () => {
      console.log(`GPortal server listening on port ${options.port}`);
    });
    this.server = new WebSocketServer({
      httpServer: this.httpServer,
      autoAcceptConnections: false,
    });
    this.server.on("request", (request) => {
      const parsedUrl = url.parse(request.httpRequest.url, true);
      const tokenFromUrl = parsedUrl.pathname.substring(1);
      this.validateJwt(tokenFromUrl, options.secret)
        .then((decodedJWT) => {
          if (decodedJWT["G_type"] == undefined || decodedJWT["G_id"] == undefined) {
            this.emit("jwtIdError", decodedJWT);
            return;
          }
          let G_connection = request.accept(null, request.origin);
          G_connection.send(
            JSON.stringify(this.G_portal_msgs.connectionAccepted)
          );
          G_connection["G_id"] = decodedJWT["G_id"];
          G_connection["G_type"] = decodedJWT["G_type"];
          G_connection["G_ignore"] = true;
          this.emit("acceptConnect", decodedJWT);
          if (G_connection["G_type"] == "iotDevice") {
            this.iotDevice_addConnection(G_connection);
            this.iotDevice_getAndUpdateControlDevices(G_connection);
          }
          else if (G_connection["G_type"] == "controlDevice") {
            this.controlDevice_addConnection(G_connection);
          }

          G_connection.on("message", (message) => {
            G_connection.send(JSON.stringify(this.G_portal_msgs.msgReceived));
            if (message.type === "utf8") {
              try {
                let receivedJSONObj = JSON.parse(message.utf8Data);
                this.emit("jsonReceived", receivedJSONObj);
                this.processMsg(G_connection, receivedJSONObj);
              } catch (e) {
                console.log("Error: ", e);
                this.emit("noJsonMsg", message.utf8Data);
              }
            }
          });
        })
        .catch((err) => {
          request.reject(403, "Invalid URL");
          this.emit("hackTry", request);
          return;
        });
    });
  }

  validateJwt(token, secret) {
    return new Promise((resolve, reject) => {
      jwt.verify(token, secret, (err, decodedJWT) => {
        if (err) {
          reject(err);
        } else {
          resolve(decodedJWT);
        }
      });
    });
  }

  async processMsg(G_connection, receivedJSONObj) {
    if (G_connection.G_type == "iotDevice") {
      while (this.G_iotDevices[G_connection.G_id]["G_controlDevices"] == undefined)
        await Utility.delay(100);
      if (receivedJSONObj.G_msg_type == "introduction") {
        this.emit("introduction", receivedJSONObj);
        this.iotDevice_updateOwnerControlDevice(G_connection, receivedJSONObj)
          .then((result) => {
            //console.log("Document updated:", result);
            this.iotDevice_updateControlDeviceList(G_connection);
          })
          .catch((err) => {
            console.error("Error updating document:", err);
          });
      }
    } else if (G_connection.G_type == "controlDevice") {
      if (receivedJSONObj.G_msg_type == "introduction") {
        this.emit("introduction", receivedJSONObj);
      }
    }
  }

  iotDevice_addConnection(G_connection) {
    if (!this.G_iotDevices) {
      this.G_iotDevices = {};
    }
    if (!this.G_iotDevices[G_connection.G_id]) {
      this.G_iotDevices[G_connection.G_id] = {};
    }
    this.G_iotDevices[G_connection.G_id]["G_connection"] = G_connection;
  }

  iotDevice_getAndUpdateControlDevices(G_connection) {
    this.G_options.db
      .findone(this.G_options.dbName, this.G_options.iotDevicesCollectionName, {
        G_id: G_connection.G_id,
      })
      .then((foundIotDevice) => {
        if (foundIotDevice) {
          // console.log("Found document:", foundIotDevice);
          this.iotDevice_addControlDevices(
            G_connection,
            foundIotDevice.G_controlDevices,
          );
        } else {
          // console.log(`No ioDevice id: ${G_connection.G_id}`);
          const newDeviceDoc = {
            G_id: G_connection.G_id,
          };
          this.G_options.db
            .insertOne(
              this.G_options.dbName,
              this.G_options.iotDevicesCollectionName,
              newDeviceDoc
            )
            .then((result) => {
              // console.log("Inserted document:", result);
            })
            .catch((err) => {
              console.error("Error inserting document:", err);
            });
        }
      })
      .catch((err) => {
        console.error("Error finding document:", err);
      });
  }

  iotDevice_addControlDevices(G_connection, G_last_controlDevices) {
    if (!this.G_iotDevices[G_connection.G_id]["G_controlDevices"])
      this.G_iotDevices[G_connection.G_id]["G_controlDevices"] = {};

    Object.keys(G_last_controlDevices).forEach((controlDevice) => {
      this.G_iotDevices[G_connection.G_id]["G_controlDevices"][controlDevice] =
      {
        ...this.G_iotDevices[G_connection.G_id]["G_controlDevices"][controlDevice],//the last updated
        ...G_last_controlDevices[controlDevice],//new fetched from db
      };
    });

    //console.log("ControlDeviceAdded", this.G_iotDevices[G_connection.G_id]["G_controlDevices"])
  }

  iotDevice_updateOwnerControlDevice(G_connection, receivedJSONObj) {
    return new Promise((resolve, reject) => {
      // Iterate through G_controlDevices and set 'access' to 2 for devices with 'access' equal to 1
      this.G_iotDevices[G_connection.G_id]["G_controlDevices"] &&
        Object.keys(this.G_iotDevices[G_connection.G_id]["G_controlDevices"]).forEach(
          (controlDevice) => {
            if (this.G_iotDevices[G_connection.G_id]["G_controlDevices"][controlDevice]['access'] == 1)
              this.G_iotDevices[G_connection.G_id]["G_controlDevices"][controlDevice]['access'] = 2;
          }
        );

      if (!this.G_iotDevices[G_connection.G_id]["G_controlDevices"][receivedJSONObj.G_owner])
        this.G_iotDevices[G_connection.G_id]["G_controlDevices"][receivedJSONObj.G_owner] = {};

      this.G_iotDevices[G_connection.G_id]["G_controlDevices"][receivedJSONObj.G_owner]['access'] = 1;

      this.G_options.db
        .updateOne(
          this.G_options.dbName,
          this.G_options.iotDevicesCollectionName,
          { G_id: G_connection.G_id },
          { G_controlDevices: this.G_iotDevices[G_connection.G_id]["G_controlDevices"] }
        )
        .then((result) => {
          // Uncomment the next line if you want to log the result.
          // console.log("Updated document:", result);
          resolve(result);
        })
        .catch((err) => {
          console.error("Error updating document:", err);
          reject(err);
        });
    });
  }

  iotDevice_updateControlDeviceList(G_connection) {
    this.G_iotDevices[G_connection.G_id]["G_controlDevices"] &&
      Object.keys(this.G_iotDevices[G_connection.G_id]["G_controlDevices"]).forEach(
        (controlDevice) => {
          if (!this.G_controlDevices)
            this.G_controlDevices = {};

          if (!this.G_controlDevices[controlDevice])
            this.G_controlDevices[controlDevice] = {};

          this.G_controlDevices[controlDevice][G_connection.G_id] = {};
          this.G_controlDevices[controlDevice][G_connection.G_id]['G_connection'] = G_connection;
          this.G_controlDevices[controlDevice][G_connection.G_id]['access'] =
            this.G_iotDevices[G_connection.G_id]["G_controlDevices"][controlDevice]['access'];
        }
      );
  }

  controlDevice_addConnection(G_connection) {
    if (!this.G_controlDevices) {
      this.G_controlDevices = {};
    }
    if (!this.G_controlDevices[G_connection.G_id]) {
      this.G_controlDevices[G_connection.G_id] = {};
    }
    this.G_controlDevices[G_connection.G_id]["G_connection"] = G_connection;
  }

  getIotDevices() {
    let G_iotDevices_c = _.cloneDeep(this.G_iotDevices);
    Utility.deleteIgnoredObj(G_iotDevices_c);
    if(!G_iotDevices_c)
    Object.keys(G_iotDevices_c).forEach(device => {
      G_iotDevices_c[device]['connected'] = this.G_iotDevices[device]['G_connection'].connected;
    });
    return G_iotDevices_c;
  }

  getcontrolDevices() {
    let G_controlDevices_c = _.cloneDeep(this.G_controlDevices);
    Utility.deleteIgnoredObj(G_controlDevices_c);
    if(!G_controlDevices_c)
    Object.keys(G_controlDevices_c).forEach(device => {
      if (this.G_controlDevices[device]['G_connection'])
        G_controlDevices_c[device]['connected'] = this.G_controlDevices[device]['G_connection'].connected;
    });
    return G_controlDevices_c;
  }
}

module.exports = GPortalServer;
