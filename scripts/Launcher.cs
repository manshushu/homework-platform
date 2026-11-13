using System;
using System.Diagnostics;
using System.IO;

namespace HomeworkPlatform
{
    class Program
    {
        static void Main(string[] args)
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string batPath = Path.Combine(baseDir, "start.bat");

            if (!File.Exists(batPath))
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("错误: 未找到启动脚本 start.bat");
                Console.WriteLine("路径: " + batPath);
                Console.ResetColor();
                Console.WriteLine("按任意键退出...");
                Console.ReadKey();
                return;
            }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "cmd.exe";
            psi.Arguments = "/c \"" + batPath + "\"";
            psi.WorkingDirectory = baseDir;
            psi.UseShellExecute = false;

            try
            {
                using (Process proc = Process.Start(psi))
                {
                    proc.WaitForExit();
                }
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("启动服务异常: " + ex.Message);
                Console.ResetColor();
                Console.WriteLine("按任意键退出...");
                Console.ReadKey();
            }
        }
    }
}
