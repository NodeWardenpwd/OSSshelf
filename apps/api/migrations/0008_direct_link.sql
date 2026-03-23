-- 0008_direct_link.sql
-- 添加文件直链功能
-- 为 files 表添加 direct_link_token 和 direct_link_expires_at 字段

-- 添加直链 token 字段（唯一）
ALTER TABLE files ADD COLUMN direct_link_token TEXT UNIQUE;

-- 添加直链过期时间字段
ALTER TABLE files ADD COLUMN direct_link_expires_at TEXT;

-- 创建索引加速通过 token 查询
CREATE INDEX idx_files_direct_link_token ON files(direct_link_token);
