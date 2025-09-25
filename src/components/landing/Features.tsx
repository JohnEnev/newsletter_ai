import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ClipboardCheck, MailCheck, ScrollText } from "lucide-react";

const items = [
  {
    title: "Personalized picks",
    description:
      "We surface articles that match your interests using lightweight signals and tags.",
    icon: ScrollText,
  },
  {
    title: "Quick surveys",
    description:
      "Give feedback in a tap. We learn your preferences and improve suggestions.",
    icon: ClipboardCheck,
  },
  {
    title: "Magic link login",
    description:
      "No passwords. Sign in securely with a link sent to your email.",
    icon: MailCheck,
  },
];

export function Features() {
  return (
    <section id="features" className="w-full py-12 sm:py-16">
      <div className="mx-auto max-w-5xl px-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <Card key={item.title}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <item.icon className="h-5 w-5 text-foreground" />
                  <CardTitle className="text-base">{item.title}</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <CardDescription>{item.description}</CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

