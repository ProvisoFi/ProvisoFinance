-- The bot now links and takes commands only in private chats (a private chat's id is the user's
-- id, always positive). Group and channel links made before that (negative ids) are dropped.
delete from public.telegram_links where chat_id < 0;
