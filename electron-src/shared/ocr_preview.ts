export interface OcrPreviewRequest {
    sceneId: string;
    sceneName: string;
    includeBoxes: boolean;
}

export interface OcrPreviewBox {
    points: [number, number][];
    text: string;
}

export interface OcrPreviewFrame {
    sceneId: string;
    sceneName: string;
    sourceName: string;
    imageData: string;
    width: number;
    height: number;
    capturedAt: number;
    boxes: OcrPreviewBox[];
}
