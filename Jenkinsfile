pipeline {
    agent any // Or specify a node with Docker installed, e.g., agent { label 'docker' }

    environment {
        IMAGE_NAME = 'downtime-exporter'
        IMAGE_TAG = "v1.0.${env.BUILD_NUMBER}"
    }

    stages {
        stage('Checkout') {
            steps {
                // Checkout the source code from your Git repository
                git 'https://github.com/skang88/downtime-exporter'
            }
        }

        stage('Build Docker Image') {
            steps {
                script {
                    echo "Building Docker image: ${IMAGE_NAME}:${IMAGE_TAG}"
                    docker.build("${IMAGE_NAME}:${IMAGE_TAG}", '.')
                }
            }
        }

        stage('Deploy') {
            steps {
                // This deployment strategy assumes Jenkins has SSH access to the Docker host.
                // You will need to configure SSH credentials in Jenkins with the ID 'your-ssh-credentials'.
                echo "Deploying ${IMAGE_NAME}:${IMAGE_TAG}..."
                withCredentials([sshUserPrivateKey(credentialsId: 'your-ssh-credentials', keyFileVariable: 'SSH_KEY')]) {
                    sh '''
                        ssh -i $SSH_KEY -o StrictHostKeyChecking=no user@your-server.com " \
                            docker stop ${IMAGE_NAME} || true && \
                            docker rm ${IMAGE_NAME} || true && \
                            docker run -d --rm --name ${IMAGE_NAME} -p 8002:8002 \
                                -e DB_HOST=your_db_host \
                                -e DB_USER=your_db_user \
                                -e DB_PASSWORD=your_db_password \
                                -e DB_DATABASE=your_db_name \
                                ${IMAGE_NAME}:${IMAGE_TAG}
                        "
                    '''
                }
            }
        }
    }

    post {
        always {
            // Clean up workspace or send notifications
            echo 'Pipeline finished.'
        }
    }
}
