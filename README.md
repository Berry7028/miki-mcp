# miki - MacOS 自動操作エージェント

Vision LLM (Gemini) と PyAutoGUI を使用した、MacOS 自動操作 CLI エージェントです。
自然言語による指示を受け取り、画面を認識しながら自律的にタスクを完了します。

## 主な機能

- **MCP Server**: Model Context Protocol (MCP) サーバーとして、任意のLLMクライアントからmacOSを操作可能
- **Vision LLM ベースの自律操作**: Gemini 3 Flash Preview を使用し、画面のスクリーンショットを解析して次のアクションを決定
- **正規化座標系**: 画面解像度に依存しない 0-1000 の正規化座標系を提供
- **Google 検索統合**: エージェントが自律的にGoogle検索を行い、操作手順やアプリケーションの使い方を調査
- **バッチ実行**: 関連する操作を一括実行することで、効率的かつ高速な動作を実現
- **UI要素解析**: アクセシビリティAPIを活用し、GUI要素の正確な位置を取得
- **OSAスクリプト実行**: AppleScriptを使用したアプリケーション起動や制御
- **リアルタイムヒント入力**: 実行中にユーザーからの追加指示を受け付け

## アーキテクチャ

```
miki/
├── src/
│   ├── index.ts        # MCP Server - ツール定義・プロトコル実装
│   ├── python-bridge.ts # Python Executorとの通信管理
│   ├── cli/            # CLIインターフェース (Ink)
│   ├── controller/     # TypeScript (Bun) - エージェントの思考・制御
│   │   ├── agent.ts    # Agentロジック（LLM統合、ループ制御）
│   │   └── types.ts    # 型定義・スキーマ
│   └── executor/       # Python - MacOSの実際の操作
│       ├── main.py     # アクションディスパッチャー
│       └── actions/    # 個別アクション（screenshot, ui_elements等）
├── venv/               # Python仮想環境（pyautogui, pyobjc等）
└── package.json
```

詳細はこちら [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)


- **Controller (TypeScript/Bun)**: LLMからのツール呼び出し（JSON）を受け取り、実行環境へブリッジ
- **Executor (Python)**: pyautogui と PyObjC を使用し、OSレベルでマウス・キーボードを制御

## MCP Server として利用

### MCPクライアントへの登録

Claude Desktop などの MCP クライアントに以下の設定を追加してください：

```json
{
  "mcpServers": {
    "miki": {
      "command": "bun",
      "args": ["run", "/path/to/miki-mcp/src/index.ts"],
      "cwd": "/path/to/miki-mcp"
    }
  }
}
```

### 利用可能なMCPツール

#### 観察ツール (Observation Tools)

| ツール名 | 説明 | 入力パラメータ |
|---------|------|---------------|
| `screenshot` | 現在の画面とマウス位置を取得 | `{ highlight_pos?: {x, y} }` |
| `elementsJson` | 指定したアプリのUI要素の階層構造をJSONで取得 | `{ app_name: string, max_depth: number }` |
| `webElements` | ブラウザ内のDOM要素を抽出 | `{ app_name: string }` |
| `getScreenSize` | 実際の画面ピクセルサイズを取得 | なし |

#### 座標ベース操作ツール

座標はすべて **0 から 1000** の範囲で指定します（左上が 0, 0）。

| ツール名 | 説明 | 入力パラメータ |
|---------|------|---------------|
| `click` | 指定位置をクリック | `{ x: number, y: number }` |
| `move` | カーソルを移動 | `{ x: number, y: number }` |
| `drag` | ドラッグ操作 | `{ from_x, from_y, to_x, to_y }` |
| `type` | 文字列を入力 | `{ text: string }` |
| `press` | 単一キーの押下 | `{ key: string }` |
| `hotkey` | ショートカット実行 | `{ keys: string[] }` |
| `scroll` | 画面スクロール | `{ amount: number }` |

#### 高度な操作ツール

| ツール名 | 説明 | 入力パラメータ |
|---------|------|---------------|
| `clickElement` | 意味ベースでUI要素をクリック | `{ app_name, role, name }` |
| `osa` | AppleScriptを直接実行 | `{ script: string }` |
| `batch` | 一連の操作を一括実行 | `{ actions: Action[] }` |

## 準備

### 1. 環境変数の設定

`.env` ファイルを作成し、Gemini API キーを設定してください（CLIモード使用時）：

```bash
GEMINI_API_KEY=your-api-key-here
```

### 2. 依存関係のインストール

**Python (venv):**

```bash
python3 -m venv venv
source venv/bin/activate
pip install pyautogui pillow pyobjc-core pyobjc-framework-Quartz pyobjc-framework-Cocoa pyperclip
```

**Bun:**

```bash
bun install
```

### 3. 実行権限の付与

MacOS の「システム設定 > プライバシーとセキュリティ > アクセシビリティ」にて、実行するターミナル（または `python`、`bun`）に許可を与えてください。

## 使い方

### MCPサーバーとして起動

```bash
bun run mcp
```

### CLIエージェントとして実行

デフォルトのゴール（YouTubeで猫を検索）で実行：

```bash
bun run start
```

### カスタムゴールの指定

```bash
bun run start "ブラウザを開いて、今日の天気を確認してください。"
```

### 実行中のヒント入力

エージェント実行中に、標準入力から追加の指示やヒントを与えることができます：

```bash
# エージェント起動中にターミナルに入力すると、次のステップで反映されます
検索ボタンは右上です
```

## システムプロンプト設計ガイド（LLM向け）

LLMにMikiを使いこなさせるためのベストプラクティス：

### 思考の優先順位

1. **意味ベースの操作を優先**: 座標 (`click`) よりも UI要素 (`clickElement`) を優先
2. **AppleScriptの活用**: アプリの起動は `osa` で行う方が確実
3. **入力前のフォーカス**: `type` を行う前には、必ず対象のフィールドを `click` する

### 座標系の理解

> 「XとYの両方で0から1000までの正規化座標を使用してください。これは画面解像度に関係なく、画面全体の相対的な位置を示します。」

### ハイブリッド戦略

1. `elementsJson` で操作したいボタンの name を確認
2. `clickElement` で実行
3. UI要素が見つからなければ、`screenshot` で位置を確認し、`click(x, y)` で直接叩く
4. 複雑なウィンドウ操作は `osa` (AppleScript) で解決

## 注意事項

- **緊急停止**: PyAutoGUIの `FAILSAFE` 機能が有効です。マウスカーソルを画面の四隅のいずれかに素早く移動させると、操作が強制停止されます
- **解像度**: Retina ディスプレイのスケーリングを考慮した座標変換を使用
- **最大ステップ数**: CLIモードではデフォルトで20ステップまで実行
- **使用ブラウザ**: Comet ブラウザを使用する設計になっています

## 技術仕様

- **プロトコル**: Model Context Protocol (MCP)
- **LLM**: Google Gemini 3 Flash Preview (vision + tool use) - CLIモード
- **実行環境**: Bun (TypeScript)
- **操作ライブラリ**: PyAutoGUI (Python)
- **座標系**: 0-1000の正規化座標を使用し、実行時に実座標へ変換
- **通信**: 標準入出力を介したJSON-RPC形式
