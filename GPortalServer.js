const http = require("http");
const WebSocketServer = require("websocket").server;
const EventEmitter = require("events");
const url = require("url");
const jwt = require("jsonwebtoken");
const _ = require("lodash");
const Utility = require("./Utility");

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
          if (this.G_options.decodeJWTValidate) {
            if (!this.G_options.decodeJWTValidate(decodedJWT)) {
              this.emit("jwtIdError", decodedJWT);
              return;
            }
          } else {
            if (
              decodedJWT["G_type"] == undefined ||
              decodedJWT["G_id"] == undefined
            ) {
              this.emit("jwtIdError", decodedJWT);
              return;
            }
          }
          let G_connection = request.accept(null, request.origin);
          G_connection.send(
            JSON.stringify(this.G_portal_msgs.connectionAccepted)
          );
          G_connection["G_id"] = decodedJWT["G_id"];
          G_connection["G_type"] = decodedJWT["G_type"];
          G_connection["G_ignore"] = true;

          this.G_options.changeGConnection &&
            this.G_options.changeGConnection(G_connection);

          this.emit("acceptConnect", { decodedJWT, G_connection });
          if (G_connection["G_type"] == "iotDevice") {
            this.iotDevice_addConnection(G_connection.G_id, G_connection);
            this.iotDevice_getSavedControlDevices(G_connection.G_id);
          } else if (G_connection["G_type"] == "controlDevice") {
            this.controlDevice_addConnection(G_connection.G_id, G_connection);
          }

          G_connection.on("message", (message) => {
            G_connection.send(JSON.stringify(this.G_portal_msgs.msgReceived));
            if (message.type === "utf8") {
              try {
                let receivedJSONObj = JSON.parse(message.utf8Data);
                this.emit("jsonReceived", { receivedJSONObj, G_connection });
                this.processMsg(G_connection, receivedJSONObj);
              } catch (e) {
                this.emit("jsonProcessError", {
                  message: message.utf8Data,
                  G_connection,
                });
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
      while (
        this.G_iotDevices[G_connection.G_id]["G_controlDevices"] == undefined
      )
        await Utility.delay(100);
      if (receivedJSONObj.G_msg_type == "introduction") {
        this.emit("introduction", { receivedJSONObj, G_connection });
        this.iotDevice_updateOwner(G_connection.G_id, receivedJSONObj.G_owner)
          .then((result) => {

            this.iotDevice_updateControlDeviceList(G_connection.G_id);
          })
          .catch((err) => {
            console.error("Error updating document:", err);
          });
      }
    } else if (G_connection.G_type == "controlDevice") {
      if (receivedJSONObj.G_msg_type == "introduction") {
        this.emit("introduction", { receivedJSONObj, G_connection });
      }
    }
  }

  iotDevice_addConnection(G_id, G_connection) {
    if (!this.G_iotDevices) {
      this.G_iotDevices = {};
    }
    if (!this.G_iotDevices[G_id]) {
      this.G_iotDevices[G_id] = {};
    }
    if (G_connection) this.G_iotDevices[G_id]["G_connection"] = G_connection;
  }

  iotDevice_getSavedControlDevices(G_id) {
    this.G_options.db
      .findone(this.G_options.dbName, this.G_options.iotDevicesCollectionName, {
        G_id: G_id,
      })
      .then((foundIotDevice) => {
        if (foundIotDevice) {
          if (!foundIotDevice.G_controlDevices)
            foundIotDevice.G_controlDevices = {};
          this.iotDevice_addSavedControlDevices(
            G_id,
            foundIotDevice.G_controlDevices
          );
        } else {
          const newDeviceDoc = {
            G_id: G_id,
            G_controlDevices: {},
          };
          this.G_options.db
            .insertOne(
              this.G_options.dbName,
              this.G_options.iotDevicesCollectionName,
              newDeviceDoc
            )
            .then((result) => {
              this.iotDevice_addSavedControlDevices(G_id, {});
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

  iotDevice_addSavedControlDevices(G_id, G_saved_controlDevices) {
    if (!this.G_iotDevices[G_id]["G_controlDevices"])
      this.G_iotDevices[G_id]["G_controlDevices"] = {};

    Object.keys(G_saved_controlDevices).forEach((controlDevice) => {
      this.G_iotDevices[G_id]["G_controlDevices"][controlDevice] = {
        ...this.G_iotDevices[G_id]["G_controlDevices"][controlDevice], 
        ...G_saved_controlDevices[controlDevice],
      };
    });
  }

  iotDevice_updateOwner(G_id, G_new_owner) {
    return new Promise((resolve, reject) => {
      if (G_new_owner) {
        this.G_iotDevices[G_id]["G_controlDevices"] &&
          Object.keys(this.G_iotDevices[G_id]["G_controlDevices"]).forEach(
            (controlDevice) => {
              if (
                this.G_iotDevices[G_id]["G_controlDevices"][controlDevice][
                  "access"
                ] == 1
              )
                this.G_iotDevices[G_id]["G_controlDevices"][controlDevice][
                  "access"
                ] = 2;
            }
          );

        if (!this.G_iotDevices[G_id]["G_controlDevices"][G_new_owner])
          this.G_iotDevices[G_id]["G_controlDevices"][G_new_owner] = {};

        this.G_iotDevices[G_id]["G_controlDevices"][G_new_owner]["access"] = 1;

        this.G_options.db
          .updateOne(
            this.G_options.dbName,
            this.G_options.iotDevicesCollectionName,
            { G_id: G_id },
            {
              G_controlDevices: this.G_iotDevices[G_id]["G_controlDevices"],
            }
          )
          .then((result) => {
            resolve(result);
          })
          .catch((err) => {
            console.error("Error updating document:", err);
            reject(err);
          });
      }
    });
  }

  iotDevice_updateControlDeviceList(G_id) {
    this.G_iotDevices[G_id]["G_controlDevices"] &&
      Object.keys(this.G_iotDevices[G_id]["G_controlDevices"]).forEach(
        (controlDevice) => {
          if (!this.G_controlDevices) this.G_controlDevices = {};

          if (!this.G_controlDevices[controlDevice])
            this.G_controlDevices[controlDevice] = {};

          if (!this.G_controlDevices[controlDevice]["G_iotDevices"])
            this.G_controlDevices[controlDevice]["G_iotDevices"] = {};

          this.G_controlDevices[controlDevice]["G_iotDevices"][G_id] = {};
          this.G_controlDevices[controlDevice]["G_iotDevices"][G_id]["access"] =
            this.G_iotDevices[G_id]["G_controlDevices"][controlDevice][
              "access"
            ];
        }
      );
  }

  controlDevice_addConnection(G_id, G_connection) {
    if (!this.G_controlDevices) {
      this.G_controlDevices = {};
    }
    if (!this.G_controlDevices[G_id]) {
      this.G_controlDevices[G_id] = {};
    }
    this.G_controlDevices[G_id]["G_connection"] = G_connection;
  }

  getIotDeviceGConnection(G_id) {
    if (this.G_iotDevices && this.G_iotDevices[G_id])
      return this.G_iotDevices[G_id]["G_connection"];
    else return undefined;
  }

  getControlDeviceGConnection(G_id) {
    if (this.G_controlDevices && this.G_controlDevices[G_id])
      return this.G_controlDevices[G_id]["G_connection"];
    else return undefined;
  }

  getIotDevices() {
    let G_iotDevices_c = _.cloneDeep(this.G_iotDevices);
    Utility.deleteIgnoredObj(G_iotDevices_c);
    if (G_iotDevices_c)
      Object.keys(G_iotDevices_c).forEach((device) => {
        if (this.G_iotDevices[device]["G_connection"])
          G_iotDevices_c[device]["connected"] =
            this.G_iotDevices[device]["G_connection"].connected;
      });
    return G_iotDevices_c;
  }

  getcontrolDevices() {
    let G_controlDevices_c = _.cloneDeep(this.G_controlDevices);
    Utility.deleteIgnoredObj(G_controlDevices_c);
    if (G_controlDevices_c)
      Object.keys(G_controlDevices_c).forEach((device) => {
        if (this.G_controlDevices[device]["G_connection"])
          G_controlDevices_c[device]["connected"] =
            this.G_controlDevices[device]["G_connection"].connected;
      });
    return G_controlDevices_c;
  }
}

module.exports = GPortalServer;
