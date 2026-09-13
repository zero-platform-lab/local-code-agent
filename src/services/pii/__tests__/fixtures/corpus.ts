/**
 * すり抜け率と誤検出率を測るための文例。
 *
 * **これは絶対の品質を示すものではない。** 私が書いた文なので、検出の作りに寄っている。
 * 数えるのは「前より悪くなっていないか」であって、「何 % 安全か」ではない。
 *
 * `pii` に書くのは、伏せられるべき語である。`clean` に書くのは、伏せてはいけない語で
 * ある。どちらも本文にそのまま現れる形で書く。
 */
export type Case = {
	text: string
	/** 伏せられるべき語。 */
	pii: string[]
	/** 伏せてはいけない語。伏せたら誤検出である。 */
	clean?: string[]
	/** 第 2 層がなければ取れないもの。第 1 層だけを測るときは数えない。 */
	needsLayerTwo?: boolean
}

export const CORPUS: Case[] = [
	// 敬称と肩書きが付く形。**第 2 層でしか取れない。**
	//
	// 第 1 層にも規則を置いていたが、外した。実データで測ったところ、第 2 層を入れて
	// いれば取れた率は変わらず（人名 97.8%）、第 1 層だけでは 1.5% しか取れず、しかも
	// 誤検出はすべてこの規則から出ていた。第 1 層は推定に頼らない、という決めごとへ戻した。
	{ text: "森さんから林の伐採について相談がありました。", pii: ["森"], clean: ["林"], needsLayerTwo: true },
	{ text: "山田部長に確認をお願いします。", pii: ["山田"], needsLayerTwo: true },
	{ text: "佐藤課長と鈴木主任が同席します。", pii: ["佐藤", "鈴木"], needsLayerTwo: true },
	{ text: "田中太郎さんへ連絡してください。", pii: ["田中太郎"], needsLayerTwo: true },

	// 人名でない語。**第 1 層に規則が無いので、いまはどれも当たらない。**
	// 似た規則を足したくなったときに、ここが赤くなる。
	{ text: "営業部長に確認します。", pii: [], clean: ["営業部長"] },
	{ text: "お客様へのご案内です。", pii: [], clean: ["お客様"] },
	{ text: "仕様を確認してください。", pii: [], clean: ["仕様"] },
	{ text: "要求仕様R.5 に則った設計です。", pii: [], clean: ["要求仕様"] },
	{ text: "多様な働き方を認めます。", pii: [], clean: ["多様"] },
	{ text: "指導教授の紹介によります。", pii: [], clean: ["指導教授"] },
	{ text: "初代事務局長を務めました。", pii: [], clean: ["初代事務局長"] },
	{ text: "世界各国の王子様、王女様の話題です。", pii: [], clean: ["王子様", "王女様"] },

	// 書式で取れるもの
	{ text: "連絡先は taro@corp.example です。", pii: ["taro@corp.example"] },
	{ text: "電話は 03-1234-5678 へ。", pii: ["03-1234-5678"] },
	{ text: "携帯は 090-1234-5678 です。", pii: ["090-1234-5678"] },
	{ text: "カードは 4111 1111 1111 1111 を使いました。", pii: ["4111 1111 1111 1111"] },
	{ text: "〒150-0041 へ送付します。", pii: ["150-0041"] },
	{ text: "住所は東京都渋谷区神南1-2-3 です。", pii: ["東京都渋谷区神南1-2-3"] },
	{ text: "api_key = 'sk-abcd1234efgh5678' を設定します。", pii: ["sk-abcd1234efgh5678"] },
	{ text: "authorization: bearer abcd1234efgh5678", pii: ["abcd1234efgh5678"] },
	{ text: "接続先は git.example.internal:8080 です。", pii: ["git.example.internal"] },
	{ text: "外向けは 203.0.113.5 です。", pii: ["203.0"] },

	// 伏せてはいけないもの
	{ text: "localhost:3000 で動かします。", pii: [], clean: ["localhost"] },
	{ text: "127.0.0.1 へ繋ぎます。", pii: [], clean: ["127.0.0.1"] },
	{ text: "サブネットは 255.255.255.0 です。", pii: [], clean: ["255.255.255.0"] },
	{ text: "github.com を参照します。", pii: [], clean: ["github.com"] },
	{ text: "Docker と React の構成を確認しました。", pii: [], clean: ["Docker", "React"] },
	{ text: "中央区の面積は 10 平方キロです。", pii: [], clean: ["中央区"] },
	{ text: "commit sha0312345678 を確認。", pii: [], clean: ["0312345678"] },
	{ text: "const apiKey = defaultApiKey", pii: [], clean: ["defaultApiKey"] },
	{ text: "設定ファイルは this.config.local です。", pii: [], clean: ["this.config.local"] },
	{ text: "注文番号は 1234567890123456 でした。", pii: [], clean: ["1234567890123456"] },

	// 第 2 層でないと取れないもの
	{ text: "担当は鈴木です。", pii: ["鈴木"], needsLayerTwo: true },
	{ text: "出席: 田中太郎、佐藤花子", pii: ["田中太郎", "佐藤花子"], needsLayerTwo: true },
	{ text: "株式会社サンプルとの契約です。", pii: ["株式会社サンプル"], needsLayerTwo: true },
	{ text: "打ち合わせに山本が来ます。", pii: ["山本"], needsLayerTwo: true },
	{ text: "受注元は丸紅物産です。", pii: ["丸紅物産"], needsLayerTwo: true },
]
