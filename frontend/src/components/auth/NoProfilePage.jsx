/**
 * No Profile Page
 * 
 * Shown when user is authenticated but has no profile row.
 */

import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export function NoProfilePage() {
    const { user, signOut } = useAuth();

    return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-100 p-4">
            <Card className="w-full max-w-md">
                <CardHeader className="text-center">
                    <div className="text-5xl mb-4">🏠</div>
                    <CardTitle className="text-2xl">Almost There!</CardTitle>
                    <CardDescription>
                        Your account needs to be linked to a church
                    </CardDescription>
                </CardHeader>

                <CardContent className="space-y-4">
                    <Alert>
                        <AlertTitle>Profile Not Found</AlertTitle>
                        <AlertDescription>
                            You're signed in as <strong>{user?.email}</strong>, but your account
                            isn't linked to a church organization yet.
                        </AlertDescription>
                    </Alert>

                    <div className="text-sm text-muted-foreground space-y-2">
                        <p><strong>Next steps:</strong></p>
                        <ul className="list-disc list-inside space-y-1">
                            <li>Contact your church administrator</li>
                            <li>Ask them to add you as a member</li>
                            <li>Once added, refresh this page</li>
                        </ul>
                    </div>

                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            className="flex-1"
                            onClick={() => window.location.reload()}
                        >
                            Refresh
                        </Button>
                        <Button
                            variant="secondary"
                            className="flex-1"
                            onClick={signOut}
                        >
                            Sign Out
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
