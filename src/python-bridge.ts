/**
 * Python Bridge - Python Executorとの通信管理
 *
 * ControllerとExecutor間は、標準入出力を介した高速なJSON-RPC形式で通信します。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import * as path from "node:path";

export interface PythonResponse {
  status: string;
  data?: string;
  width?: number;
  height?: number;
  mouse_position?: { x: number; y: number };
  elements?: string[];
  ui_data?: unknown;
  output?: string;
  message?: string;
  execution_time_ms?: number;
}

// Default timeout for Python calls in milliseconds
const DEFAULT_TIMEOUT_MS = 30000;

export interface PythonBridgeOptions {
  pythonPath?: string;
  executorPath?: string;
  timeoutMs?: number;
}

export class PythonBridge {
  private pythonProcess!: ChildProcessWithoutNullStreams;
  private pythonReader!: readline.Interface;
  private pendingResolvers: Array<{
    resolve: (value: PythonResponse) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }> = [];
  private isRestarting = false;
  private initializationPromise: Promise<void> | null = null;
  private screenSize: { width: number; height: number } = { width: 0, height: 0 };
  private readonly pythonPath: string;
  private readonly executorPath: string;
  private readonly timeoutMs: number;

  constructor(options: PythonBridgeOptions = {}) {
    // Allow configurable paths via options or environment variables
    this.pythonPath =
      options.pythonPath ||
      process.env.MIKI_PYTHON_PATH ||
      path.join(process.cwd(), "venv", "bin", "python");
    this.executorPath =
      options.executorPath ||
      process.env.MIKI_EXECUTOR_PATH ||
      path.join(process.cwd(), "src/executor/main.py");
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.startPythonProcess();
  }

  private startPythonProcess() {
    this.pythonProcess = spawn(this.pythonPath, [this.executorPath]);

    this.pythonReader = readline.createInterface({
      input: this.pythonProcess.stdout,
      terminal: false,
    });

    this.pythonReader.on("line", (line) => {
      const pending = this.pendingResolvers.shift();
      if (pending) {
        // Clear the timeout since we got a response
        clearTimeout(pending.timeoutId);
        try {
          pending.resolve(JSON.parse(line));
        } catch {
          pending.reject(new Error(`Failed to parse Python output: ${line}`));
        }
      }
    });

    this.pythonProcess.stderr.on("data", (data) => {
      // Log stderr but don't treat it as a response
      console.error(`Python stderr: ${data}`);
    });

    this.pythonProcess.on("exit", (code, signal) => {
      if (!this.isRestarting) {
        console.error(`Python process exited (code: ${code}, signal: ${signal})`);
        this.handleProcessCrash();
      }
    });

    this.pythonProcess.on("error", (error) => {
      console.error(`Python process error: ${error.message}`);
      if (!this.isRestarting) {
        this.handleProcessCrash();
      }
    });
  }

  private async handleProcessCrash() {
    if (this.isRestarting) return;

    this.isRestarting = true;

    // Clean up old process
    try {
      this.pythonReader.close();
      this.pythonProcess.kill();
    } catch {
      // Already terminated
    }

    // Reject all pending requests with their timeouts cleared
    for (const pending of this.pendingResolvers) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Python process crashed"));
    }
    this.pendingResolvers = [];

    // Reset initialization state
    this.initializationPromise = null;

    // Wait and restart
    await new Promise((resolve) => setTimeout(resolve, 1000));
    this.startPythonProcess();
    this.isRestarting = false;

    // Re-initialize
    await this.init();
  }

  private callPython(
    action: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<PythonResponse> {
    const timeout = timeoutMs ?? this.timeoutMs;

    return new Promise((resolve, reject) => {
      // Set up timeout to prevent indefinite waiting
      const timeoutId = setTimeout(() => {
        // Find and remove this pending request
        const index = this.pendingResolvers.findIndex((p) => p.timeoutId === timeoutId);
        if (index !== -1) {
          this.pendingResolvers.splice(index, 1);
        }
        reject(new Error(`Python call '${action}' timed out after ${timeout}ms`));
      }, timeout);

      this.pendingResolvers.push({ resolve, reject, timeoutId });

      try {
        this.pythonProcess.stdin.write(JSON.stringify({ action, params }) + "\n");
      } catch (error) {
        clearTimeout(timeoutId);
        const index = this.pendingResolvers.findIndex((p) => p.timeoutId === timeoutId);
        if (index !== -1) {
          this.pendingResolvers.splice(index, 1);
        }
        reject(new Error(`Failed to write to Python process: ${error}`));
      }
    });
  }

  async init(): Promise<void> {
    // Use a promise to prevent race conditions during concurrent init calls
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      const res = await this.callPython("size");
      this.screenSize = { width: res.width || 0, height: res.height || 0 };
    })();

    return this.initializationPromise;
  }

  getScreenSize(): { width: number; height: number } {
    return this.screenSize;
  }

  /**
   * Convert normalized coordinates (0-1000) to actual screen coordinates
   */
  normalizedToScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.round((x / 1000) * this.screenSize.width),
      y: Math.round((y / 1000) * this.screenSize.height),
    };
  }

  /**
   * Convert screen coordinates to normalized coordinates (0-1000)
   */
  screenToNormalized(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.round((x / this.screenSize.width) * 1000),
      y: Math.round((y / this.screenSize.height) * 1000),
    };
  }

  // ============================================
  // Observation Tools
  // ============================================

  /**
   * screenshot - 現在の画面とマウス位置を取得します
   */
  async screenshot(
    highlightPos?: { x: number; y: number },
  ): Promise<{ status: string; data?: string; mouse_position?: { x: number; y: number } }> {
    const params: Record<string, unknown> = {};
    if (highlightPos) {
      const screenPos = this.normalizedToScreen(highlightPos.x, highlightPos.y);
      params.highlight_pos = screenPos;
    }
    return await this.callPython("screenshot", params);
  }

  /**
   * elementsJson - 指定したアプリのUI要素（ボタン等）の階層構造をJSONで取得します
   */
  async elementsJson(
    appName: string,
    maxDepth: number = 3,
  ): Promise<{ status: string; ui_data?: unknown; message?: string }> {
    return await this.callPython("elementsJson", { app_name: appName, max_depth: maxDepth });
  }

  /**
   * webElements - ブラウザ内（Comet等）のDOM要素を抽出します
   */
  async webElements(appName: string): Promise<{ status: string; ui_data?: unknown; message?: string }> {
    return await this.callPython("webElements", { app_name: appName });
  }

  /**
   * getScreenSize - 実際の画面ピクセルサイズを取得します
   */
  async getScreenSizeFromPython(): Promise<{ status: string; width?: number; height?: number }> {
    const res = await this.callPython("size");
    if (res.width && res.height) {
      this.screenSize = { width: res.width, height: res.height };
    }
    return res;
  }

  // ============================================
  // Coordinate-based Operation Tools
  // ============================================

  /**
   * click - 指定位置をクリック (座標は0-1000の正規化座標)
   */
  async click(x: number, y: number): Promise<PythonResponse> {
    const screenPos = this.normalizedToScreen(x, y);
    return await this.callPython("click", screenPos);
  }

  /**
   * move - カーソルを移動 (座標は0-1000の正規化座標)
   */
  async move(x: number, y: number): Promise<PythonResponse> {
    const screenPos = this.normalizedToScreen(x, y);
    return await this.callPython("move", screenPos);
  }

  /**
   * drag - ファイル移動やウィンドウのリサイズに使用 (座標は0-1000の正規化座標)
   */
  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<PythonResponse> {
    const fromScreenPos = this.normalizedToScreen(fromX, fromY);
    const toScreenPos = this.normalizedToScreen(toX, toY);
    return await this.callPython("drag", {
      from_x: fromScreenPos.x,
      from_y: fromScreenPos.y,
      to_x: toScreenPos.x,
      to_y: toScreenPos.y,
    });
  }

  /**
   * type - 文字列を入力
   */
  async type(text: string): Promise<PythonResponse> {
    return await this.callPython("type", { text });
  }

  /**
   * press - 単一キー（enter, tab等）の押下
   */
  async press(key: string): Promise<PythonResponse> {
    return await this.callPython("press", { key });
  }

  /**
   * hotkey - ショートカット実行 (例: ["command", "c"])
   */
  async hotkey(keys: string[]): Promise<PythonResponse> {
    return await this.callPython("hotkey", { keys });
  }

  /**
   * scroll - 画面スクロール
   */
  async scroll(amount: number): Promise<PythonResponse> {
    return await this.callPython("scroll", { amount });
  }

  // ============================================
  // Advanced Operation Tools
  // ============================================

  /**
   * clickElement - 座標ではなく意味ベースで操作（"Music"アプリの"再生"ボタン等）
   */
  async clickElement(appName: string, role: string, name: string): Promise<PythonResponse> {
    return await this.callPython("clickElement", { app_name: appName, role, name });
  }

  /**
   * osa - AppleScriptを直接実行
   */
  async osa(script: string): Promise<PythonResponse> {
    return await this.callPython("osa", { script });
  }

  /**
   * elements - GUI要素一覧を取得
   */
  async elements(appName: string): Promise<{ status: string; elements?: string[]; message?: string }> {
    return await this.callPython("elements", { app_name: appName });
  }

  /**
   * focusElement - UI要素にフォーカスを当てる
   */
  async focusElement(appName: string, role: string, name: string): Promise<PythonResponse> {
    return await this.callPython("focusElement", { app_name: appName, role, name });
  }

  /**
   * typeToElement - UI要素にテキスト入力
   */
  async typeToElement(appName: string, role: string, name: string, text: string): Promise<PythonResponse> {
    return await this.callPython("typeToElement", { app_name: appName, role, name, text });
  }

  /**
   * clickWebElement - ブラウザ内のWeb要素をクリック
   */
  async clickWebElement(appName: string, role: string, name: string): Promise<PythonResponse> {
    return await this.callPython("clickWebElement", { app_name: appName, role, name });
  }

  /**
   * batch - 一連の操作を一括実行
   */
  async batch(
    actions: Array<{ action: string; params?: Record<string, unknown> }>,
  ): Promise<{ results: PythonResponse[] }> {
    const results: PythonResponse[] = [];

    for (const actionItem of actions) {
      const { action, params = {} } = actionItem;

      // Convert normalized coordinates for coordinate-based actions
      let processedParams = { ...params };
      if (
        (action === "click" || action === "move") &&
        typeof params.x === "number" &&
        typeof params.y === "number"
      ) {
        processedParams = this.normalizedToScreen(params.x as number, params.y as number);
      } else if (action === "drag") {
        const fromScreenPos = this.normalizedToScreen(params.from_x as number, params.from_y as number);
        const toScreenPos = this.normalizedToScreen(params.to_x as number, params.to_y as number);
        processedParams = {
          from_x: fromScreenPos.x,
          from_y: fromScreenPos.y,
          to_x: toScreenPos.x,
          to_y: toScreenPos.y,
        };
      }

      const result = await this.callPython(action, processedParams);
      results.push(result);

      // Small delay between batch actions for stability
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return { results };
  }

  /**
   * Close the Python bridge with timeout
   */
  destroy(): void {
    // Clear all pending requests
    for (const pending of this.pendingResolvers) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Python bridge destroyed"));
    }
    this.pendingResolvers = [];

    try {
      // Try to send exit command first
      this.pythonProcess.stdin.write(JSON.stringify({ action: "exit" }) + "\n");

      // Give the process a short time to exit gracefully
      const killTimeout = setTimeout(() => {
        try {
          this.pythonProcess.kill("SIGKILL");
        } catch {
          // Already terminated
        }
      }, 1000);

      this.pythonProcess.once("exit", () => {
        clearTimeout(killTimeout);
      });

      this.pythonReader.close();
      this.pythonProcess.kill("SIGTERM");
    } catch {
      // Already terminated
    }
  }
}
