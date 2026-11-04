/** wrangler は .html を文字列として読み込む（既定のモジュール規則 Text） */
declare module '*.html' {
  const text: string;
  export default text;
}
