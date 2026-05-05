# tennis-caliper-ar

ARを使ってテニスネット高さ調整を支援するアプリの開発リポジトリです。

## Docs

- 引き継ぎメモ（正本）: `docs/handoff_ja.md`
- MVP要件定義: `docs/mvp-requirements_ja.md`
- フィードバック収集ガイド: `docs/feedback-collection_ja.md`

運用上の必須は上記3つです。  
`docs/local-test-plan_ja.md` / `docs/simulator-strategy_ja.md` / `docs/closed-beta-plan_ja.md` / `docs/tennis-net-ar_handoff_ja.md` は履歴・補助資料として必要時のみ参照します。

## Roadmap

- ローカルで致命障害を潰し、最小Go条件を満たす
- クローズドベータ（5〜10人）で失敗フィードバックを収集
- 失敗上位3件を優先修正して反復
- 現地検証は学習サイクルを回した後に実施

## Working Principles

- 最小差分より全体整合を優先する。
- 失敗時は曖昧に継続せず、条件と確認手順を明記する。
- 公式情報と実務推奨を分けて記録する。

## Run Local Prototype

```bash
cd /Users/miyagikenta/Documents/github/tennis-caliper-ar
python3 -m http.server 8080
```

`http://localhost:8080/` を開くと、判定ロジック先行のローカルプロトタイプを確認できます。
