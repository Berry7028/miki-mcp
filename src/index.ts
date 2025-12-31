#!/usr/bin/env node
/**
 * Miki MCP Server - macOS Automation Server
 *
 * LLMがmacOSを人間のように直感的に、かつエンジニアのように正確に操作するための
 * Model Context Protocol (MCP) サーバーです。
 *
 * 座標系: 画面解像度に依存しない正規化座標系 (0-1000) を提供し、LLMの推論を安定させます。
 * - (0, 0) が画面の左上
 * - (1000, 1000) が画面の右下
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PythonBridge } from "./python-bridge.js";

// Initialize Python bridge
const pythonBridge = new PythonBridge();

// Create MCP server
const server = new McpServer({
  name: "miki",
  version: "1.0.0",
});

// ============================================
// A. Observation Tools (観察ツール)
// ============================================

/**
 * screenshot - 現在の画面とマウス位置を取得します
 */
server.tool(
  "screenshot",
  "Take a screenshot of the current screen and get mouse position. Optionally highlight a specific position.",
  {
    highlight_pos: z
      .object({
        x: z.number().min(0).max(1000).describe("X coordinate (normalized 0-1000)"),
        y: z.number().min(0).max(1000).describe("Y coordinate (normalized 0-1000)"),
      })
      .optional()
      .describe("Optional position to highlight with a red dot"),
  },
  async ({ highlight_pos }) => {
    await pythonBridge.init();
    const result = await pythonBridge.screenshot(highlight_pos);

    if (result.status === "success" && result.data) {
      const screenSize = pythonBridge.getScreenSize();
      const mouseNormalized = result.mouse_position
        ? pythonBridge.screenToNormalized(result.mouse_position.x, result.mouse_position.y)
        : { x: 0, y: 0 };

      return {
        content: [
          {
            type: "image" as const,
            data: result.data,
            mimeType: "image/png",
          },
          {
            type: "text" as const,
            text: JSON.stringify({
              mouse_position: mouseNormalized,
              screen_size: screenSize,
            }),
          },
        ],
      };
    }

    return {
      content: [{ type: "text" as const, text: `Error: ${result.status}` }],
      isError: true,
    };
  },
);

/**
 * elementsJson - 指定したアプリのUI要素（ボタン等）の階層構造をJSONで取得します
 */
server.tool(
  "elementsJson",
  "Get UI elements hierarchy (buttons, text fields, etc.) of the specified application in JSON format. Uses Accessibility API.",
  {
    app_name: z.string().describe("Application name (e.g., 'Comet', 'Safari', 'Music')"),
    max_depth: z.number().min(1).max(10).default(3).describe("Maximum depth of UI hierarchy to traverse"),
  },
  async ({ app_name, max_depth }) => {
    await pythonBridge.init();
    const result = await pythonBridge.elementsJson(app_name, max_depth);

    if (result.status === "success" && result.ui_data) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.ui_data, null, 2) }],
      };
    }

    return {
      content: [{ type: "text" as const, text: `Error: ${result.message || "Failed to get UI elements"}` }],
      isError: true,
    };
  },
);

/**
 * webElements - ブラウザ内（Comet等）のDOM要素を抽出します
 */
server.tool(
  "webElements",
  "Extract web page elements (links, buttons, forms) from browser's web content area. Works with browsers like Comet, Safari.",
  {
    app_name: z.string().describe("Browser application name (e.g., 'Comet', 'Safari')"),
  },
  async ({ app_name }) => {
    await pythonBridge.init();
    const result = await pythonBridge.webElements(app_name);

    if (result.status === "success" && result.ui_data) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.ui_data, null, 2) }],
      };
    }

    return {
      content: [{ type: "text" as const, text: `Error: ${result.message || "Failed to get web elements"}` }],
      isError: true,
    };
  },
);

/**
 * getScreenSize - 実際の画面ピクセルサイズを取得します
 */
server.tool("getScreenSize", "Get the actual screen pixel size.", {}, async () => {
  await pythonBridge.init();
  const result = await pythonBridge.getScreenSizeFromPython();

  if (result.status === "success") {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ width: result.width, height: result.height }),
        },
      ],
    };
  }

  return {
    content: [{ type: "text" as const, text: "Error: Failed to get screen size" }],
    isError: true,
  };
});

// ============================================
// B. Coordinate-based Operation Tools (座標ベース操作ツール)
// 座標はすべて 0 から 1000 の範囲で指定します（左上が 0, 0）
// ============================================

/**
 * click - 指定位置をクリック
 */
server.tool(
  "click",
  "Click at the specified position. Coordinates use normalized 0-1000 range where (0,0) is top-left.",
  {
    x: z.number().min(0).max(1000).describe("X coordinate (normalized 0-1000)"),
    y: z.number().min(0).max(1000).describe("Y coordinate (normalized 0-1000)"),
  },
  async ({ x, y }) => {
    await pythonBridge.init();
    const result = await pythonBridge.click(x, y);

    return {
      content: [
        {
          type: "text" as const,
          text:
            result.status === "success"
              ? `Clicked at (${x}, ${y})`
              : `Error: ${result.message || "Click failed"}`,
        },
      ],
      isError: result.status !== "success",
    };
  },
);

/**
 * move - カーソルを移動
 */
server.tool(
  "move",
  "Move the cursor to the specified position. Coordinates use normalized 0-1000 range.",
  {
    x: z.number().min(0).max(1000).describe("X coordinate (normalized 0-1000)"),
    y: z.number().min(0).max(1000).describe("Y coordinate (normalized 0-1000)"),
  },
  async ({ x, y }) => {
    await pythonBridge.init();
    const result = await pythonBridge.move(x, y);

    return {
      content: [
        {
          type: "text" as const,
          text:
            result.status === "success"
              ? `Moved cursor to (${x}, ${y})`
              : `Error: ${result.message || "Move failed"}`,
        },
      ],
      isError: result.status !== "success",
    };
  },
);

/**
 * drag - ファイル移動やウィンドウのリサイズに使用
 */
server.tool(
  "drag",
  "Drag from one position to another. Useful for file moving, window resizing, and range selection. Coordinates use normalized 0-1000 range.",
  {
    from_x: z.number().min(0).max(1000).describe("Start X coordinate (normalized 0-1000)"),
    from_y: z.number().min(0).max(1000).describe("Start Y coordinate (normalized 0-1000)"),
    to_x: z.number().min(0).max(1000).describe("End X coordinate (normalized 0-1000)"),
    to_y: z.number().min(0).max(1000).describe("End Y coordinate (normalized 0-1000)"),
  },
  async ({ from_x, from_y, to_x, to_y }) => {
    await pythonBridge.init();
    const result = await pythonBridge.drag(from_x, from_y, to_x, to_y);

    return {
      content: [
        {
          type: "text" as const,
          text:
            result.status === "success"
              ? `Dragged from (${from_x}, ${from_y}) to (${to_x}, ${to_y})`
              : `Error: ${result.message || "Drag failed"}`,
        },
      ],
      isError: result.status !== "success",
    };
  },
);

/**
 * type - 文字列を入力
 */
server.tool(
  "type",
  "Type text at the current cursor position. Make sure to click/focus the target input field first.",
  {
    text: z.string().describe("Text to type"),
  },
  async ({ text }) => {
    await pythonBridge.init();
    const result = await pythonBridge.type(text);

    return {
      content: [
        {
          type: "text" as const,
          text:
            result.status === "success" ? `Typed: "${text}"` : `Error: ${result.message || "Type failed"}`,
        },
      ],
      isError: result.status !== "success",
    };
  },
);

/**
 * press - 単一キー（enter, tab等）の押下
 */
server.tool(
  "press",
  "Press a single key (e.g., enter, tab, escape, up, down, left, right, space, delete, backspace).",
  {
    key: z.string().describe("Key to press (e.g., 'enter', 'tab', 'escape')"),
  },
  async ({ key }) => {
    await pythonBridge.init();
    const result = await pythonBridge.press(key);

    return {
      content: [
        {
          type: "text" as const,
          text:
            result.status === "success" ? `Pressed: ${key}` : `Error: ${result.message || "Press failed"}`,
        },
      ],
      isError: result.status !== "success",
    };
  },
);

/**
 * hotkey - ショートカット実行
 */
server.tool(
  "hotkey",
  'Execute a keyboard shortcut (e.g., ["command", "c"] for copy, ["command", "v"] for paste).',
  {
    keys: z
      .array(z.string())
      .describe('Keys to press together (e.g., ["command", "c"], ["command", "shift", "s"])'),
  },
  async ({ keys }) => {
    await pythonBridge.init();
    const result = await pythonBridge.hotkey(keys);

    return {
      content: [
        {
          type: "text" as const,
          text:
            result.status === "success"
              ? `Executed hotkey: ${keys.join("+")}`
              : `Error: ${result.message || "Hotkey failed"}`,
        },
      ],
      isError: result.status !== "success",
    };
  },
);

/**
 * scroll - 画面スクロール
 */
server.tool(
  "scroll",
  "Scroll the screen. Positive values scroll up, negative values scroll down.",
  {
    amount: z.number().describe("Scroll amount (positive = up, negative = down)"),
  },
  async ({ amount }) => {
    await pythonBridge.init();
    const result = await pythonBridge.scroll(amount);

    return {
      content: [
        {
          type: "text" as const,
          text:
            result.status === "success"
              ? `Scrolled by ${amount}`
              : `Error: ${result.message || "Scroll failed"}`,
        },
      ],
      isError: result.status !== "success",
    };
  },
);

// ============================================
// C. Advanced Operation Tools (高度な操作ツール)
// ============================================

/**
 * clickElement - 意味ベースで操作
 * 座標ではなく「"Music"アプリの"再生"ボタン」のように意味ベースで操作します。
 * 解像度やウィンドウ位置の変化に非常に強いです。
 */
server.tool(
  "clickElement",
  "Click a UI element by its semantic meaning (role and name) instead of coordinates. Very robust against layout changes.",
  {
    app_name: z.string().describe("Application name"),
    role: z.string().describe("UI element role (e.g., 'AXButton', 'AXTextField', 'AXCheckBox')"),
    name: z.string().describe("UI element name/label"),
  },
  async ({ app_name, role, name }) => {
    await pythonBridge.init();
    const result = await pythonBridge.clickElement(app_name, role, name);

    return {
      content: [
        {
          type: "text" as const,
          text:
            result.status === "success"
              ? `Clicked element: ${role} "${name}" in ${app_name}`
              : `Error: ${result.message || "Element click failed. Try using coordinate-based click as fallback."}`,
        },
      ],
      isError: result.status !== "success",
    };
  },
);

/**
 * osa - AppleScript実行
 * アプリの起動、ウィンドウの最大化、システム設定の変更など、
 * GUI操作よりも高速で確実な制御が可能です。
 */
server.tool(
  "osa",
  'Execute AppleScript directly. Faster and more reliable for app launching, window management, and system settings. Example: tell application "Safari" to activate',
  {
    script: z.string().describe("AppleScript code to execute"),
  },
  async ({ script }) => {
    await pythonBridge.init();
    const result = await pythonBridge.osa(script);

    return {
      content: [
        {
          type: "text" as const,
          text:
            result.status === "success"
              ? `AppleScript executed${result.output ? `: ${result.output}` : " successfully"}`
              : `Error: ${result.message || "AppleScript execution failed"}`,
        },
      ],
      isError: result.status !== "success",
    };
  },
);

/**
 * batch - 一括実行
 * 「クリック→入力→エンター」といった一連の操作を、通信の往復なしに一括実行します。
 */
server.tool(
  "batch",
  "Execute multiple actions in sequence without round-trip delays. Efficient for common patterns like click->type->enter.",
  {
    actions: z
      .array(
        z.object({
          action: z.string().describe("Action name (click, type, press, hotkey, move, scroll, drag, osa)"),
          params: z.record(z.string(), z.unknown()).optional().describe("Action parameters"),
        }),
      )
      .describe("Array of actions to execute in sequence"),
  },
  async ({ actions }) => {
    await pythonBridge.init();
    const result = await pythonBridge.batch(actions);

    const allSuccessful = result.results.every((r) => r.status === "success");
    const summary = result.results
      .map((r, i) => `${i + 1}. ${actions[i]?.action}: ${r.status}`)
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: allSuccessful
            ? `Batch executed ${actions.length} actions successfully:\n${summary}`
            : `Batch completed with some errors:\n${summary}`,
        },
      ],
      isError: !allSuccessful,
    };
  },
);

// Additional helper tools

/**
 * focusElement - UI要素にフォーカス
 */
server.tool(
  "focusElement",
  "Focus a UI element by its role and name. Useful before typing into text fields.",
  {
    app_name: z.string().describe("Application name"),
    role: z.string().describe("UI element role"),
    name: z.string().describe("UI element name/label"),
  },
  async ({ app_name, role, name }) => {
    await pythonBridge.init();
    const result = await pythonBridge.focusElement(app_name, role, name);

    return {
      content: [
        {
          type: "text" as const,
          text:
            result.status === "success"
              ? `Focused element: ${role} "${name}" in ${app_name}`
              : `Error: ${result.message || "Focus failed"}`,
        },
      ],
      isError: result.status !== "success",
    };
  },
);

/**
 * typeToElement - UI要素にテキスト入力
 */
server.tool(
  "typeToElement",
  "Focus a UI element and type text into it. Combines focusElement + type.",
  {
    app_name: z.string().describe("Application name"),
    role: z.string().describe("UI element role (usually 'AXTextField')"),
    name: z.string().describe("UI element name/label"),
    text: z.string().describe("Text to type"),
  },
  async ({ app_name, role, name, text }) => {
    await pythonBridge.init();
    const result = await pythonBridge.typeToElement(app_name, role, name, text);

    return {
      content: [
        {
          type: "text" as const,
          text:
            result.status === "success"
              ? `Typed "${text}" into ${role} "${name}" in ${app_name}`
              : `Error: ${result.message || "Type to element failed"}`,
        },
      ],
      isError: result.status !== "success",
    };
  },
);

/**
 * clickWebElement - ブラウザ内Web要素をクリック
 */
server.tool(
  "clickWebElement",
  "Click a web element inside a browser by its role and name.",
  {
    app_name: z.string().describe("Browser application name"),
    role: z.string().describe("Web element role (e.g., 'AXLink', 'AXButton')"),
    name: z.string().describe("Web element name/text"),
  },
  async ({ app_name, role, name }) => {
    await pythonBridge.init();
    const result = await pythonBridge.clickWebElement(app_name, role, name);

    return {
      content: [
        {
          type: "text" as const,
          text:
            result.status === "success"
              ? `Clicked web element: ${role} "${name}" in ${app_name}`
              : `Error: ${result.message || "Web element click failed"}`,
        },
      ],
      isError: result.status !== "success",
    };
  },
);

/**
 * elements - GUI要素一覧取得（レガシー形式）
 */
server.tool(
  "elements",
  "Get GUI elements list in legacy format (role|name|position|size). Use elementsJson for structured data.",
  {
    app_name: z.string().describe("Application name"),
  },
  async ({ app_name }) => {
    await pythonBridge.init();
    const result = await pythonBridge.elements(app_name);

    if (result.status === "success" && result.elements) {
      return {
        content: [{ type: "text" as const, text: result.elements.join("\n") }],
      };
    }

    return {
      content: [{ type: "text" as const, text: `Error: ${result.message || "Failed to get elements"}` }],
      isError: true,
    };
  },
);

// Start the server
async function main() {
  await pythonBridge.init();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    pythonBridge.destroy();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    pythonBridge.destroy();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
