# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

退職者などのユーザを Google Workspace (GWS) と Entra ID から削除する Google Apps Script (GAS) プロジェクト。スプレッドシートの A列（削除対象）・B列（データ移行先、空なら `appsadmin@odk.co.jp`）を読み込んで処理する。clasp でローカル管理している（`.clasp.json` は gitignore 済み）。

## コマンド

- `clasp push` — ローカルのコードを GAS に反映（`rootDir` はリポジトリ直下、`.js` がそのまま `.gs` として扱われる）
- 実行は GAS エディタから関数を選んで行う。ビルド・テスト・lint の仕組みはない
- `node --check <file>.js` — 構文チェックのみ可能（GAS API は Node では動かない）
- `npm install` は型定義 `@types/google-apps-script` のためだけ（エディタ補完用）

## 構成

GAS は全ファイルがグローバルスコープを共有するため、ファイルをまたいで関数・定数を直接参照している。

- `検証.js` — 読み取り専用の事前チェック。`verifyTargetUsers` が実行入口。`validateTargets` / `readTargetUsers` / `getEntraToken` / `findGwsUser` / `findEntraUser` は削除処理からも再利用される共通部品
- `コード.js` — 削除処理本体。`removeUser` が実行入口

### 削除処理の流れと設計上の決定事項

1. `validateTargets` で全行チェック。**1件でもNGがあれば処理全体を中断する**（NG行だけスキップはしない。リスト自体の誤りを疑うため）
2. 全員分のデータ移行を Data Transfer API で先にまとめて依頼（Google 側で並行処理させる）
3. 移行が `completed` になったユーザだけ削除する。API では移行と削除が別リクエストで、`Users.remove` は移行中でも削除できてしまうため、完了確認は必須
4. GWS 削除 → Entra ID 削除の順。Entra は GWS の削除リクエストが成功した場合のみ実行し、GWS 側の削除完了は待たない

移行内容は管理コンソールで手作業時の設定に合わせている（`TRANSFER_APPS`）：ドライブ（非共有ファイル含む）、カレンダー（リソース解放なし）、Looker Studio（共有アセットのみ）。Gmail・Classroom は対象外。

### 制約・注意点

- `DRY_RUN = true` の間はチェックのみで移行・削除しない
- GAS の実行時間上限（6分）があるため移行完了待ちは `TRANSFER_WAIT_LIMIT_MS`（5分）まで。未完了ユーザは削除せずスキップする
- 削除済みユーザが残ったリストで再実行すると「GWSに存在しない」でNGになり全体が中断するので、処理済み行はリストから外す必要がある
- 高度なサービス `AdminDirectory` / `AdminDataTransfer` を `appsscript.json` で有効化している
- 設定値（`SPREADSHEET_ID`, `SHEET_NAME`, `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`）はスクリプトプロパティに保存する。Entra はクライアントクレデンシャルフローで、削除には `User.ReadWrite.All`（アプリケーション権限）が必要
- Entra のユーザは GWS のメールアドレスを UPN として検索している（同一である前提）
