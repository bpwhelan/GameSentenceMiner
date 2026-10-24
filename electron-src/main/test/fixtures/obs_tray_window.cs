// A small OBS/Qt stand-in: showing its HWND exposes an empty frame. Its
// interface is initialized only by the same tray callback used by real OBS.
using System;
using System.IO;
using System.Runtime.InteropServices;

internal static class ObsTrayWindowFixture {
    private delegate IntPtr WindowProcedure(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WindowClass {
        public uint style;
        public WindowProcedure procedure;
        public int classExtra, windowExtra;
        public IntPtr instance, icon, cursor, background;
        public string menuName, className;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Message {
        public IntPtr window;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x, y;
        public uint privateData;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern ushort RegisterClass(ref WindowClass windowClass);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWindowEx(uint extendedStyle, string className, string title,
        uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu,
        IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DefWindowProc(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out Message message, IntPtr window, uint minimum, uint maximum);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DispatchMessage(ref Message message);

    private static readonly WindowProcedure MainProcedure = DefWindowProc;
    private static readonly WindowProcedure TrayProcedure = HandleTrayMessage;
    private static IntPtr mainWindow, contentWindow;
    private static string journal;

    private static IntPtr HandleTrayMessage(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam) {
        if (message == 0x8065 && (lParam.ToInt64() & 0xffff) == 0x0400) {
            File.AppendAllText(journal, "tray-selected\n");
            if (IsWindowVisible(mainWindow)) {
                ShowWindow(mainWindow, 0);
            } else {
                if (contentWindow == IntPtr.Zero) {
                    contentWindow = CreateWindowEx(0, "STATIC", "OBS interface restored through Qt",
                        0x50000000, 10, 10, 300, 40, mainWindow, IntPtr.Zero,
                        GetModuleHandle(null), IntPtr.Zero);
                }
                ShowWindow(mainWindow, 4);
                if (IsWindowVisible(contentWindow)) File.AppendAllText(journal, "interface-visible\n");
            }
            return IntPtr.Zero;
        }
        return DefWindowProc(window, message, wParam, lParam);
    }

    private static void Register(string name, WindowProcedure procedure) {
        var windowClass = new WindowClass {
            procedure = procedure, instance = GetModuleHandle(null),
            background = new IntPtr(6), className = name,
        };
        if (RegisterClass(ref windowClass) == 0) throw new InvalidOperationException("Cannot register test window.");
    }

    [STAThread]
    private static void Main(string[] args) {
        journal = args[0];
        Register("QtGsmObsTrayFixture", MainProcedure);
        Register("QtGsmTrayIconMessageWindowClass", TrayProcedure);
        mainWindow = CreateWindowEx(0x08000080, "QtGsmObsTrayFixture", "OBS tray restore regression fixture",
            0x00cf0000, -30000, -30000, 400, 160, IntPtr.Zero, IntPtr.Zero,
            GetModuleHandle(null), IntPtr.Zero);
        var trayWindow = CreateWindowEx(0, "QtGsmTrayIconMessageWindowClass", "QTrayIconMessageWindow",
            0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
        if (mainWindow == IntPtr.Zero || trayWindow == IntPtr.Zero) throw new InvalidOperationException("Cannot create test windows.");
        File.WriteAllText(journal, "ready\n");
        Message message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
    }
}
