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
}

interface Message {
    function: FunctionName;
    data?: { [key: string]: any };
    id?: string | null;
}

class WebSocketManager {
    private wss: WebSocketServer | null = null;
    private ws: WebSocket | null = null;

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

    sendMessage(message: Message): void {
        if (this.ws) {
            const jsonString = JSON.stringify(message);
            this.ws.send(jsonString);
        } else {
            console.error("WebSocket is not connected.");
        }
    }

    sendQuitMessage(): void {
        this.sendMessage({ function: FunctionName.Quit });
    }

    private receiveMessage(message: Message) {
        try {
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

webSocketManager.startServer()