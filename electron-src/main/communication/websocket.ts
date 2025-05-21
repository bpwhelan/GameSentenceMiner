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

class WebSocketManager {
    private wss: WebSocketServer | null = null;
    ws: WebSocket | null = null;

    async startServer() {
        const port = await detectPort(store.get("port"));
        store.set("port", port);
        this.wss = new WebSocketServer({ port });

        console.log(`WebSocket server running on ws://localhost:${port}`);

        this.wss.on("connection", (ws) => {
            console.debug("Python connected");
            this.ws = ws;

            ws.on("message", (message) => {
                try {
                    const data: Message = JSON.parse(message.toString());
                    console.debug("Received from Python:", data);
                    this.receiveMessage(data);

                    // Send a JSON response
                    ws.send(JSON.stringify({ function: FunctionName.Start }));
                } catch (error) {
                    console.error("Invalid JSON received:", message.toString());
                }
            });

            ws.on("close", () => {
                console.log("Python disconnected");
                this.ws = null;
            });
        });

        return port;
    }

    async sendMessage(message: Message): Promise<boolean> {
        return new Promise(async (resolve, reject) => {
            this.waitForWebSocketConnection().then(() => {
                if (this.ws) {
                    console.info("Sending to Python:", message);
                    const jsonString = JSON.stringify(message);
                    this.ws.send(jsonString);
                    resolve(true);
                } else {
                    console.error("WebSocket is not connected.");
                    resolve(false);
                }
            });
        })
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
            const maxAttempts = 5;
            const interval = setInterval(() => {
                if (webSocketManager.ws) {
                    clearInterval(interval);
                    resolve();
                } else if (++attempts >= maxAttempts) {
                    clearInterval(interval);
                    reject(new Error("WebSocket connection failed after 5 attempts."));
                }
            }, 100);
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
            }
        } catch (error) {
            console.error("Error parsing message:", error);
        }
    }
}

export const webSocketManager = new WebSocketManager();

webSocketManager.startServer().then((port) => {
    console.log(`WebSocket server started on port ${port}`);
});