-- =====================================================================
-- 004: Brukeren kan slette sin egen konto
-- Kjøres ÉN gang i Supabase: SQL Editor → lim inn alt → Run
-- =====================================================================

-- Sletter den innloggede brukeren. Alt som hører til kontoen (profil,
-- Telegram-kobling, ruter, varselhistorikk) forsvinner automatisk med den.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Ikke innlogget';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant  execute on function public.delete_my_account() to authenticated;

notify pgrst, 'reload schema';
