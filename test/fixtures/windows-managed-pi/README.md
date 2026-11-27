这份夹具回答官方 Windows 受管安装如何选择 Node 和实际的 pi 进程。

前置阅读：[Pi 官方安装器](https://pi.dev/install.ps1)、[Pi 1.5.2](https://github.com/earendil-works/pi/releases/tag/v1.5.2)。

三个文件取自上述官方安装器（SHA256 `3ba23d3451e17649495bdee14414ec1f3616ad7ae7246b4edd2e7166e7b3af51`）。取其 `Write-PiManagedLaunchers` 的两个 cmd 模板和 JS 模板，代入发行时的包名和命令，保存为 LF。两种 cmd 分别使用 PATH 中的 Node 和安装器自带的 Node。测试使用这份原始 JS 和临时假 pi 入口，不需要账号。随附上游项目版权及 MIT 许可。[许可证](LICENSE)
