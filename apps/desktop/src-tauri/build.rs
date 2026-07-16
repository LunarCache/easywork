fn main() {
    // tauri-build 只跟踪 tauri.conf.json，不会自动跟踪其中引用的图标文件。
    // 否则 `tauri dev` 只会重启旧二进制，Dock 仍显示上一次编译进程序列化进去的图标。
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
