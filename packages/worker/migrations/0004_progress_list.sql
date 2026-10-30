-- 0.3: claiming an issue moves its card to an "In progress" list; resolving moves it to Done.
ALTER TABLE projects ADD COLUMN progress_list_id TEXT;    -- Trello "In progress" list; found or created lazily if null
