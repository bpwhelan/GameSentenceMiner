import Store from 'electron-store';
import WebSocket, { WebSocketServer } from "ws";
import detectPort from "detect-port";

interface Config {
    port: number;
}

const store = new Store<Config>({
    defaults: {
        port: 8766,
    },
    name: 'shared_config',
});

enum FunctionName {
    CONNECTED = "on_connect",
    Quit = "quit",
    Start = "start",
    Stop = "stop",
    Restart = "restart",
    QuitOBS = "quit_obs",
    StartOBS = "start_obs",
    OpenSettings = "open_settings",
}

interface Message {
    function: FunctionName;
    data?: { [key: string]: any };
    id?: string | null;
}

let connected = false;
let shuttingDown = false;

class WebSocketManager {
    private wss: WebSocketServer | null = null;
    ws: WebSocket | null = null;

    async startServer() {
        const port = await detectPort(store.get("port"));
        store.set("port", port);
        this.wss = new WebSocketServer({ port });

        console.log(`WebSocket server running on ws://localhost:${port}`);

        this.wss.on("connection", (ws) => {
            connected = true;
            console.debug("Python connected");
            this.ws = ws; // Set the instance's ws property when a connection is established

            ws.on("message", (message) => {
                const msgStr = message.toString();
                if (msgStr === "PING") {
                    // Optionally respond to PING if needed
                    ws.send("PONG");
                    return;
                }
                try {
                    const data: Message = JSON.parse(msgStr);
                    console.debug("Received from Python:", data);
                    this.receiveMessage(data);
                } catch (error) {
                    console.debug("Invalid JSON received:", msgStr);
                }
                ws.send(message); // Acknowledge receipt
            });

            ws.on("close", () => {
                if (connected) {
                    console.info("Python disconnected");
                    connected = false;
                }
                this.ws = null;
            });

            ws.on("error", (error) => {
                console.error("WebSocket error:", error);
            });
        });

        this.wss.on("error", (error) => {
            console.error("WebSocket server error:", error);
        });

        return port;
    }

    async sendMessage(message: Message): Promise<boolean> {
        return new Promise(async (resolve) => {
            try {
                await this.waitForWebSocketConnection();
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    console.info("Sending to Python:", message);
                    const jsonString = JSON.stringify(message);
                    this.ws.send(jsonString);
                    resolve(true);
                } else {
                    console.error("WebSocket is not connected or not open.");
                    resolve(false);
                }
            } catch (error) {
                console.error("Failed to send message:", error);
                resolve(false);
            }
        });
    }

    async sendQuitMessage(): Promise<boolean> {
        return await this.sendMessage({ function: FunctionName.Quit });
    }

    async sendQuitOBS() {
        await this.sendMessage({ function: FunctionName.QuitOBS });
    }

    async sendStartOBS() {
        await this.sendMessage({ function: FunctionName.StartOBS });
    }

    async sendOpenSettings() {
        await this.sendMessage({ function: FunctionName.OpenSettings });
    }

    async waitForWebSocketConnection(): Promise<void> {
        return new Promise((resolve, reject) => {
            let attempts = 0;
            const maxAttempts = 10;
            const initialDelay = 50;
            const intervalTime = 200;

            const checkConnection = () => {
                if (shuttingDown) {
                    clearInterval(interval);
                    resolve();
                }
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    clearInterval(interval);
                    resolve();
                } else if (++attempts >= maxAttempts) {
                    clearInterval(interval);
                    reject(new Error(`WebSocket connection failed after ${maxAttempts} attempts.`));
                }
            };

            const interval = setInterval(checkConnection, intervalTime);
            setTimeout(checkConnection, initialDelay);
        });
    }

    private receiveMessage(message: Message) {
        try {
            console.log("Received message from python:", message);
            switch (message.function) {
                case FunctionName.Start:
                    console.log("Start received");
                    break;
                case FunctionName.Stop:
                    console.log("Stop received");
                    break;
                case FunctionName.Restart:
                    console.log("Restart received");
                    break;
                case FunctionName.CONNECTED:
                    console.log("Connected Message Receieved")
                    break;
            }
        } catch (error) {
            console.error("Error parsing message:", error);
        }
    }

    async stopServer(): Promise<void> {
        shuttingDown = true;
        if (this.wss) {
            console.log("Shutting down WebSocket server...");

            // Close all active WebSocket connections
            this.wss.clients.forEach((client) => {
                client.close();
            });

            // Close the WebSocket server
            await new Promise<void>((resolve, reject) => {
                this.wss?.close((error) => {
                    if (error) {
                        console.error("Error while shutting down WebSocket server:", error);
                        reject(error);
                    } else {
                        console.log("WebSocket server successfully shut down.");
                        resolve();
                    }
                });
            });

            this.wss = null;
            connected = false;
            this.ws = null;
        } else {
            console.warn("WebSocket server is not running.");
        }
    }
}

export const webSocketManager = new WebSocketManager();