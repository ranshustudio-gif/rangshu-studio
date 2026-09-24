# rangshu-studio
RAN · SHU Architecture / Interior

## 後台管理系統

這個專案已整合 Supabase 管理後台，可在不修改程式碼的情況下新增、編輯、刪除作品與建築旅遊筆記。

### 1. 開啟後台

直接在瀏覽器開啟：

- admin.html

登入時請使用 Supabase Authentication 建立的管理員帳號與密碼。

### 2. Supabase 設定

1. 建立新 Supabase 專案。
2. 在 SQL Editor 粘貼執行 [supabase-schema.sql](supabase-schema.sql) 的內容。
3. 進入 Authentication → Users 建立管理員帳號。
4. 取得該帳號 UUID，執行：

```sql
insert into public.app_admin (id) values ('<auth-user-uuid>');
```

5. 在 Storage 建立 bucket：`site-assets`，並設為 public。
6. 確認 [supabase-config.js](supabase-config.js) 中的 URL 與 publishable key 為你專案的設定值。

### 3. 管理功能

- Works：新增、編輯、刪除作品；包含案名、年份、地點、類型、面積、設計介紹、封面、照片與發布狀態。
- Journal：新增、編輯、刪除筆記；包含標題、日期、地點、內文、封面、照片與發布狀態。
- 草稿與發布狀態：只有已發布內容會出現在前台。
- 上傳的照片會存入 Supabase Storage，前台讀取 public URL。
- 刪除前會確認，儲存與發布會顯示成功或失敗訊息。

### 4. 前台顯示

- index.html 會讀取已發布作品。
- journal.html 會讀取已發布筆記。
- journal-post.html 顯示完整內容。
- work-post.html 顯示完整作品頁。

### 5. 注意事項

- 不要將 service_role secret 放進前端。
- 只有 admin 帳號才能新增、修改、刪除、上傳圖片。
- 若看不到資料，請確認 SQL 已執行完成且資料狀態是 published。
