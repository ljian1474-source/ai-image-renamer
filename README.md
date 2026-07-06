# 识图改名

一个只做“上传图片 → AI识别 → 自动生成文件名 → 批量下载”的极简网站。

## 功能

- JPG、PNG、WEBP 批量上传
- AI 自动生成简体中文文件名
- 文件名可手动修改
- 自动过滤 Windows 非法文件名字符
- 同名文件自动追加 `-2`、`-3`
- 原图不压缩、不改画质，浏览器本地打包 ZIP
- 不登录、不建数据库、不保存图片

## 本地运行

需要 Node.js 20 或更高版本，以及一个 Cloudflare 账号。

```bash
npm install
npx wrangler login
npm run dev
```

打开终端显示的本地网址即可。

## 部署到 Cloudflare

```bash
npm install
npx wrangler login
npm run deploy
```

部署成功后，终端会返回一个免费的 `workers.dev` 网址。

## 免费额度说明

项目使用 Cloudflare Workers AI。免费额度耗尽后，接口会直接报“今天的免费识图额度已用完”，不会在免费套餐下自动扣费。

## 项目结构

```text
public/          前端页面
src/index.js     AI识图接口
wrangler.jsonc   Cloudflare 配置
```
