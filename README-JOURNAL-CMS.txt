把這 4 個檔案放進 rangshu-studio 資料夾：
- admin.html
- journal.html
- journal-post.html
- supabase-config.js

使用：
1. 開 admin.html，用你在 Supabase 建立的管理員 Email / Password 登入。
2. 新增標題、日期、封面、簡介、內容後按「儲存」。
3. journal.html 會自動顯示新文章，不需要再改 HTML。
4. 點文章會到 journal-post.html?id=文章ID。
5. 上線時把這些檔案一起 push 到 GitHub Pages。

注意：publishable key 可公開；不要把 secret/service_role key 放進網站。
