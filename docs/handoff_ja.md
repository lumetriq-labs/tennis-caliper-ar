# tennis-caliper-ar 引き継ぎメモ（日本語）

更新日: 2026-05-05

## この資料の役割

この文書を正本として、チャット履歴がなくても作業再開できる状態を保つ。
利用者向けの概要は `README.md`、初期検討のログは `docs/tennis-net-ar_handoff_ja.md` に残す。

### ドキュメント最小運用（現在）

- 必須:
  - `docs/handoff_ja.md`（現在地と次アクション）
  - `docs/mvp-requirements_ja.md`（やること/やらないこと）
  - `docs/feedback-collection_ja.md`（テスト結果の記録形式）
- 参照用（必要時のみ）:
  - `docs/local-test-plan_ja.md`
  - `docs/simulator-strategy_ja.md`
  - `docs/closed-beta-plan_ja.md`
  - `docs/tennis-net-ar_handoff_ja.md`

## 再開チェックリスト

1. `git status` で差分を確認する。
2. `README.md` の Docs と Roadmap を読み、現在の優先作業を確認する。
3. `docs/mvp-requirements_ja.md` を開き、未確定項目を確認する。
4. 必要に応じて `docs/tennis-net-ar_handoff_ja.md` を参照し、背景経緯を確認する。
5. 作業開始前に、この文書末尾の「作業中断メモ」を更新して焦点を固定する。

## 目的（要約）

- スマホカメラ映像にテニスネットの正しい高さガイドを重ね、ネット調整を支援する。
- ARを使って現地で再現可能な高さ合わせを行う。

## 実現方針（現時点）

- 実現自体は可能。
- 方式ごとの精度の目安:
  - 2Dオーバーレイのみ: 実装は簡単だがズレやすい
  - AR平面認識 + キャリブレーション: 実用寄り
- 技術選定の初期方針:
  - スマホWebブラウザを前提に、精度要件を満たす実装を優先
  - WebXR + フォールバック設計を候補にする

## MVPスコープ

1. カメラプレビュー表示
2. 基準点キャリブレーション（例: 支柱根元2点）
3. 高さガイド表示（中央 0.914m、ポスト側 1.07m）
4. 高低差表示（高い/低い、可能なら cm）

## 現在の実装状況（要点）

- 入力ソース:
  - シミュレーション値
  - 保存動画（ダミーカメラ入力）
- 基準推定:
  - 自動モード（白ライン + Y寄りT字を許容した簡易検出）
  - 手動モード（2点タップ）
- オーバーレイ:
  - 自動推定ライン
  - 中央基準線
  - 許容帯（±1 / ±3 / ±5）
  - 現在線（判定に応じて色変更）
- 判定:
  - リアルタイム自動更新
  - 自動推定信頼度に応じた保守補正

## 特徴量（検出ログ）について

フィードバックJSONには、検出改善用の特徴量を含める実装に更新済み。
`context.detectionDebug` に以下を格納する:

- `rowStrength`
- `colStrength`
- `tHorizontalScore`
- `tVerticalScoreSym`
- `tVerticalScoreDown`
- `tVerticalScoreUp`
- `tVerticalScoreFinal`
- `tScore`

## 先に確定すべき要件

- 許容誤差は選択式（±1cm / ±3cm / ±5cm）で確定済み
- 対象プラットフォームはスマホWebブラウザで確定済み
- 未確定は「各精度モードの成立条件（環境条件）」のみ
- 環境条件は時間帯単独ではなく、照明条件・コート種別・端末条件で定義する

要件詳細は `docs/mvp-requirements_ja.md` で管理する。

## ドキュメント運用ルール

- `README.md`: 外部向け概要と入口
- `docs/handoff_ja.md`: 実装再開の正本
- `docs/mvp-requirements_ja.md`: 現行要件
- `docs/feedback-collection_ja.md`: フィードバック記録ルール
- その他の docs は補助資料として保持し、更新は必要時のみ

## 作業中断メモ

| 項目 | 内容 |
|------|------|
| いまの焦点 | 機能充足性（実カメラ表示 / ガイド更新 / JSON記録）の確認 |
| 未完 | 低信頼時の挙動最適化（判定停止/警告強化） |
| 次の一手 | 機能充足性が揃ったら、斜め撮影と低照度を優先して精度改善に着手する |

