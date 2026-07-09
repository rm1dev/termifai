fn main() {
    #[cfg(target_os = "windows")]
    {
        embed_resource::compile("termifaid.rc", embed_resource::NONE);
    }
}
