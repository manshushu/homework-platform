using System;
using System.Diagnostics;
using System.IO;

namespace HomeworkPlatformUpgrade
{
    class Program
    {
        static void Main(string[] args)
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string batPath = Path.Combine(baseDir, "一键升级部署.bat");

            if (!File.Exists(batPath))
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("Error: 一键升级部署.bat not found in " + baseDir);
                Console.ResetColor();
                Console.WriteLine("Press any key to exit...");
                Console.ReadKey();
                return;
            }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "cmd.exe";
            psi.Arguments = "/c \"\"" + batPath + "\"\"";
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
                Console.WriteLine("Launch failed: " + ex.Message);
                Console.ResetColor();
                Console.WriteLine("Press any key to exit...");
                Console.ReadKey();
            }
        }
    }
}
